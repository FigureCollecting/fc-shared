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
 *   - The batch queue is bounded and DROPS when full; ending a span never
 *     blocks and a dead collector never throws into the app (forceFlush and
 *     shutdown swallow export errors). forceFlush, shutdown and runJob's final
 *     flush DO wait for the collector, at most exportTimeoutMillis (default
 *     10 s) when it accepts connections and never answers; the OTLP exporter
 *     gets the same deadline, so shutdown is bounded by it too.
 *   - Propagation allowlist, OTEL_PROPAGATION_ALLOWLIST (default
 *     `*.svc.cluster.local,*.svc,localhost`): the http and undici
 *     instrumentations skip any other host (no auto span, no header), and the
 *     global propagator, W3C traceparent + baggage behind the
 *     AllowlistPropagator, injects for listed hosts only on every other path.
 *   - An AsyncLocalStorage context manager is registered explicitly, so the
 *     active span survives `await`.
 *   - It must be the process's ONLY OpenTelemetry setup. If another one (e.g.
 *     NodeSDK) registered the context manager, propagator or tracer provider
 *     first, startTracing throws and releases whatever it did register:
 *     otherwise the allowlist and the redaction would silently not apply.
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
  PROPAGATION_ALLOWLIST_ENV,
  createHostAllowlist,
  propagationHostsFromEnv,
  propagationTargetOf,
  withPropagationTarget,
} from './propagation';
export {
  DROPPED_ATTRIBUTE_KEYS,
  DROPPED_ATTRIBUTE_PREFIXES,
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
  /**
   * Per-export budget before it is abandoned, and the longest forceFlush waits
   * on a collector that never answers. Also the OTLP exporter's deadline.
   * Default 10000.
   */
  exportTimeoutMillis?: number;
}

export interface StartTracingOptions {
  version?: string;
  /** Environment to read. Default: process.env. */
  env?: Env;
  /**
   * Instrumentations to register against this provider (e.g. http, undici, pg),
   * flat or nested one level as registerInstrumentations takes them (the
   * OpenTelemetry docs pass `[getNodeAutoInstrumentations()]`).
   */
  instrumentations?: Array<Instrumentation | Instrumentation[]>;
  /** Test seam: export here instead of OTLP (still redacted and batched). */
  exporter?: SpanExporter;
  /** Hosts added to the propagation allowlist (OTEL_PROPAGATION_ALLOWLIST, else its defaults). */
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

type IgnoreHook = (request: unknown) => boolean;

/**
 * Where an instrumentation-http request goes, read as that instrumentation
 * reads it (hostname, else host up to the port; node's default is localhost).
 */
function httpRequestHost(request: unknown): string {
  const { hostname, host } = request as { hostname?: unknown; host?: unknown };
  if (typeof hostname === 'string' && hostname !== '') return hostname;
  const match = /^([^:/ ]+)/.exec(typeof host === 'string' ? host : '');
  return match === null ? 'localhost' : match[1];
}

/** Where an instrumentation-undici request (fetch included) goes: its origin's host; undefined if unreadable. */
function undiciRequestHost(request: unknown): string | undefined {
  try {
    return new URL((request as { origin: string }).origin).hostname;
  } catch {
    return undefined;
  }
}

/** Per instrumentation: the config key of its outbound ignore hook, and how it names the host. */
const OUTBOUND_GATES = new Map<string, { hook: string; hostOf: (request: unknown) => string | undefined }>([
  ['@opentelemetry/instrumentation-http', { hook: 'ignoreOutgoingRequestHook', hostOf: httpRequestHost }],
  ['@opentelemetry/instrumentation-undici', { hook: 'ignoreRequestHook', hostOf: undiciRequestHost }],
]);

/**
 * Make the http and undici instrumentations skip every request to a host that
 * is not allowed, or cannot be read: no auto span and no header. For an
 * allowed host the caller's own ignore hook still decides. Returns an undo
 * that puts the caller's hook back.
 */
function skipOffListHosts(instrumentations: readonly Instrumentation[], isAllowed: (host: string) => boolean): () => void {
  const undo: Array<() => void> = [];
  for (const instrumentation of instrumentations) {
    const gate = OUTBOUND_GATES.get(instrumentation.instrumentationName);
    if (gate === undefined) continue;
    const own = (instrumentation.getConfig() as Record<string, unknown>)[gate.hook] as IgnoreHook | undefined;
    const skip: IgnoreHook = (request) => {
      const host = gate.hostOf(request);
      if (host === undefined || !isAllowed(host)) return true;
      return own?.(request) ?? false;
    };
    instrumentation.setConfig({ ...instrumentation.getConfig(), [gate.hook]: skip });
    undo.push(() => instrumentation.setConfig({ ...instrumentation.getConfig(), [gate.hook]: own }));
  }
  return () => undo.forEach((restore) => restore());
}

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
 * running handle unchanged. Throws if another OpenTelemetry setup already
 * registered a global (see the module comment).
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
    const batch = { ...BATCH_DEFAULTS, ...options.batch };
    // One deadline: a gRPC call left in flight would otherwise hold shutdown for
    // the exporter's own 10 s default, whatever exportTimeoutMillis says.
    const target = options.exporter ?? new OTLPTraceExporter({ url: endpoint, timeoutMillis: batch.exportTimeoutMillis });
    processor = new BatchSpanProcessor({ ...batch, exporter: new RedactingSpanExporter(target, options.redact) });
  }

  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': identity.service, 'service.version': identity.version }),
    spanProcessors: [processor],
  });

  const contextManager = new AsyncLocalStorageContextManager().enable();
  const propagateHosts = [...propagationHostsFromEnv(env), ...(options.propagateHosts ?? [])];
  const isAllowed = createHostAllowlist(propagateHosts);
  const registered = {
    context: context.setGlobalContextManager(contextManager),
    propagation: propagation.setGlobalPropagator(
      new AllowlistPropagator(
        new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
        isAllowed,
      ),
    ),
    trace: trace.setGlobalTracerProvider(provider),
  };
  const taken = Object.entries(registered)
    .filter(([, ok]) => !ok)
    .map(([api]) => api);
  if (taken.length > 0) {
    // Release only what THIS call registered; the other setup keeps its own.
    if (registered.context) context.disable();
    else contextManager.disable();
    if (registered.propagation) propagation.disable();
    if (registered.trace) trace.disable();
    void quietly('shutdown', provider.shutdown());
    throw new Error(
      'fc-shared startTracing: another OpenTelemetry setup (e.g. NodeSDK) is already running; remove it, ' +
        'startTracing must be the only one. OpenTelemetry globals already registered: ' +
        taken.join(', '),
    );
  }

  // Flattened HERE, so the off-list skip reaches every instrumentation that
  // registerInstrumentations (which flattens one level itself) will enable.
  const instrumentations = (options.instrumentations ?? []).flat();
  const restoreHooks = skipOffListHosts(instrumentations, isAllowed);
  const unregister = registerInstrumentations({ instrumentations, tracerProvider: provider });

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
      restoreHooks();
      await quietly('shutdown', provider.shutdown());
      trace.disable();
      // Also disables contextManager: the API disables the manager it holds.
      context.disable();
      propagation.disable();
      running = undefined;
    },
  };
  running = handle;
  return handle;
}
