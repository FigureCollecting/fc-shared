/**
 * NODE-ONLY tracing bootstrap: startTracing(service).
 *
 *   - Exporter: OTLP over gRPC (the estate rule: component-to-component APIs are
 *     gRPC; the hop to otel-collector.observability:4317 rides the Linkerd mesh
 *     for mTLS). Chosen when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or
 *     OTEL_EXPORTER_OTLP_ENDPOINT is set. No HTTP/protobuf exporter is offered.
 *   - No endpoint: a no-op processor. Spans still RECORD with real ids, so every
 *     log line keeps its trace_id, but nothing leaves the pod. Unsetting the env
 *     var is the rollback.
 *   - Every exported span passes the RedactingSpanExporter (query strings,
 *     userinfo, secrets).
 *   - The batch queue is bounded and DROPS when full; a dead collector never
 *     blocks or throws into the app (forceFlush/shutdown swallow export errors).
 *   - The global propagator is W3C traceparent + baggage behind the
 *     AllowlistPropagator: headers go to cluster-internal hosts only.
 *   - An AsyncLocalStorage context manager is registered explicitly, so the
 *     active span survives `await`.
 *
 * Built on @opentelemetry/sdk-trace's TracerProvider rather than NodeSDK:
 * NodeSDK also drags in the metrics and logs SDKs plus every OTLP transport,
 * and reads OTEL_TRACES_EXPORTER=none into a provider whose ids are all zero
 * (the bug that already shipped once in fc-backend).
 *
 * ESM apps: auto-instrumentation can only patch modules loaded through `import`
 * if Node is started with the OpenTelemetry loader hook, e.g.
 *
 *   node --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
 *        --import ./dist/tracing.js dist/server.js
 *
 * ESM_LOADER_HOOK is that specifier; esmLoaderHookPath() resolves it to a file
 * for images where the bare specifier would resolve from the wrong directory.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { context, diag, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
  TracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { RedactOptions } from '../utils/sanitize';
import { resolveServiceIdentity, type Env } from './log';
import { AllowlistPropagator, createHostAllowlist, propagationHostsFromEnv } from './propagation';
import { RedactingSpanExporter, stripUrl } from './redact';

export {
  AllowlistPropagator,
  DEFAULT_PROPAGATION_HOSTS,
  PROPAGATE_HOSTS_ENV,
  createHostAllowlist,
  propagationHostsFromEnv,
  propagationTargetOf,
  withPropagationTarget,
} from './propagation';
export {
  DROPPED_ATTRIBUTE_KEYS,
  RedactingSpanExporter,
  URL_ATTRIBUTE_KEYS,
  redactSpanAttributes,
  stripUrl,
} from './redact';

/** The only supported OpenTelemetry ESM loader hook. */
export const ESM_LOADER_HOOK = '@opentelemetry/instrumentation/hook.mjs';

/**
 * Absolute path of the loader hook as resolved from `fromDir` (default: the
 * current directory, i.e. the app). Throws with the fix when it is missing.
 */
export function esmLoaderHookPath(fromDir: string = process.cwd()): string {
  try {
    return createRequire(join(fromDir, 'noop.js')).resolve(ESM_LOADER_HOOK);
  } catch {
    throw new Error(
      `${ESM_LOADER_HOOK} is not resolvable from ${fromDir}; ` +
        'npm install @opentelemetry/instrumentation in the app (an optional peer of fc-shared).',
    );
  }
}

export type ExporterKind = 'otlp' | 'noop' | 'custom';

export interface BatchOptions {
  /** Spans held before new ones are DROPPED. Default 2048. */
  maxQueueSize?: number;
  /** Default 512. */
  maxExportBatchSize?: number;
  /** Default 5000. */
  scheduledDelayMillis?: number;
  /** Per-export budget before it is abandoned. Default 10000. */
  exportTimeoutMillis?: number;
}

export interface StartTracingOptions {
  version?: string;
  /** Environment to read. Default: process.env. */
  env?: Env;
  /** Instrumentations to register against this provider (e.g. http, undici, pg). */
  instrumentations?: Instrumentation[];
  /** Test seam: export here instead of OTLP (still redacted and batched). */
  exporter?: SpanExporter;
  /** Hosts ADDED to the propagation allowlist. */
  propagateHosts?: readonly string[];
  batch?: BatchOptions;
  /** Service-specific span redaction, e.g. an extra sensitive-key pattern. */
  redact?: RedactOptions;
}

export interface TracingState {
  service: string;
  version: string;
  exporter: ExporterKind;
  /** The OTLP endpoint without userinfo, query or fragment. */
  endpoint?: string;
  propagateHosts: string[];
}

export interface Tracing {
  readonly state: TracingState;
  /** Export what is queued. Never rejects: export failures are reported to diag. */
  forceFlush(): Promise<void>;
  /** Flush, stop, and release every global so tracing can start again. */
  shutdown(): Promise<void>;
}

const BATCH_DEFAULTS: Required<BatchOptions> = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5000,
  exportTimeoutMillis: 10_000,
};

/** OTLP traces endpoint: the traces-specific variable wins, blank means unset. */
export function resolveTraceEndpoint(env: Env): string | undefined {
  const endpoint = (env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ?? env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '').trim();
  return endpoint === '' ? undefined : endpoint;
}

let running: Tracing | undefined;

function quietly(label: string, work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    (error: unknown) => {
      diag.warn(`fc-shared tracing: ${label} failed`, error);
    },
  );
}

/**
 * Register tracing for this process. Idempotent: a second call returns the
 * running handle unchanged.
 */
export function startTracing(service: string, options: StartTracingOptions = {}): Tracing {
  if (running !== undefined) return running;

  const env = options.env ?? process.env;
  const identity = resolveServiceIdentity(env, { service, version: options.version });
  const endpoint = resolveTraceEndpoint(env);
  const kind: ExporterKind = options.exporter !== undefined ? 'custom' : endpoint !== undefined ? 'otlp' : 'noop';

  let processor: SpanProcessor;
  if (kind === 'noop') {
    processor = new NoopSpanProcessor();
  } else {
    const target = options.exporter ?? new OTLPTraceExporter({ url: endpoint });
    processor = new BatchSpanProcessor({
      ...BATCH_DEFAULTS,
      ...options.batch,
      exporter: new RedactingSpanExporter(target, options.redact),
    });
  }

  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': identity.service, 'service.version': identity.version }),
    spanProcessors: [processor],
  });

  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);

  const propagateHosts = [...propagationHostsFromEnv(env), ...(options.propagateHosts ?? [])];
  propagation.setGlobalPropagator(
    new AllowlistPropagator(
      new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
      createHostAllowlist(propagateHosts),
    ),
  );
  trace.setGlobalTracerProvider(provider);

  const unregister = registerInstrumentations({ instrumentations: options.instrumentations ?? [], tracerProvider: provider });

  const handle: Tracing = {
    state: {
      service: identity.service,
      version: identity.version,
      exporter: kind,
      ...(kind === 'otlp' ? { endpoint: stripUrl(endpoint as string) } : {}),
      propagateHosts,
    },
    forceFlush: () => quietly('forceFlush', provider.forceFlush()),
    shutdown: async () => {
      unregister();
      await quietly('shutdown', provider.shutdown());
      contextManager.disable();
      trace.disable();
      context.disable();
      propagation.disable();
      running = undefined;
    },
  };
  running = handle;
  return handle;
}
