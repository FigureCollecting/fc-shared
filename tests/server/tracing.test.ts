/**
 * startTracing(service): OTLP/gRPC when an endpoint is set, a no-op exporter
 * (spans still RECORD, so logs keep real trace ids) when it is not, redaction
 * on the way out, and a bounded queue that drops rather than blocks when the
 * collector is down.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpanKind, context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createLogger } from '../../src/server/log';
import {
  ESM_LOADER_HOOK,
  esmLoaderHookPath,
  resolveTraceEndpoint,
  startTracing,
  type Tracing,
} from '../../src/server/tracing';
import { captureSink } from './helpers';

let active: Tracing | undefined;
afterEach(async () => {
  await active?.shutdown();
  active = undefined;
});

function inSpan<T>(fn: () => T, name = 'work'): T {
  return trace.getTracer('test').startActiveSpan(name, (span) => {
    try {
      return fn();
    } finally {
      span.end();
    }
  });
}

describe('resolveTraceEndpoint', () => {
  it('prefers the traces-specific endpoint, then the generic one, and treats blank as unset', () => {
    expect(resolveTraceEndpoint({})).toBeUndefined();
    expect(resolveTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBeUndefined();
    expect(resolveTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector.observability:4317' })).toBe(
      'http://otel-collector.observability:4317',
    );
    expect(
      resolveTraceEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://generic:4317',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ' http://traces:4317 ',
      }),
    ).toBe('http://traces:4317');
  });
});

describe('startTracing without an endpoint (the no-op path)', () => {
  it('ships nothing but keeps spans recording, so log lines carry real trace ids', () => {
    active = startTracing('scraper', { env: { SERVICE_VERSION: '2.1.2' } });
    expect(active.state).toEqual({
      service: 'scraper',
      version: '2.1.2',
      exporter: 'noop',
      propagateHosts: ['*.svc.cluster.local', '*.svc', 'localhost'],
    });

    const { sink, parsed } = captureSink();
    const log = createLogger({ service: 'scraper', version: '2.1.2', env: {}, sink });
    const ids = inSpan(() => {
      log.info('inside');
      return trace.getActiveSpan()?.spanContext();
    });
    expect(ids?.traceId).toMatch(/^(?!0{32})[0-9a-f]{32}$/);
    expect(parsed()[0]).toMatchObject({ trace_id: ids?.traceId, span_id: ids?.spanId });
  });

  it('keeps the active span across an await (async context manager registered)', async () => {
    active = startTracing('scraper', { env: {} });
    const tracer = trace.getTracer('test');
    const [before, after] = await tracer.startActiveSpan('outer', async (span) => {
      const first = trace.getActiveSpan()?.spanContext().spanId;
      await Promise.resolve();
      const second = trace.getActiveSpan()?.spanContext().spanId;
      span.end();
      return [first, second];
    });
    expect(before).toBeDefined();
    expect(after).toBe(before);
  });

  it('reads process.env when given no options', () => {
    active = startTracing('bare');
    expect(active.state.service).toBe('bare');
    expect(active.state.exporter).toBe(resolveTraceEndpoint(process.env) === undefined ? 'noop' : 'otlp');
  });

  it('is idempotent: a second call returns the running handle', () => {
    active = startTracing('scraper', { env: {} });
    expect(startTracing('other', { env: {} })).toBe(active);
  });

  it('releases every global on shutdown so tracing can start again', async () => {
    const first = startTracing('first', { env: {} });
    await first.shutdown();
    const orphan = trace.getTracer('after').startSpan('after-shutdown');
    expect(orphan.isRecording()).toBe(false);
    orphan.end();
    expect(inSpan(() => trace.getActiveSpan())).toBeUndefined();
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    expect(carrier).toEqual({});

    active = startTracing('second', { env: {} });
    expect(active).not.toBe(first);
    expect(active.state.service).toBe('second');
  });

  it('adds FC_TRACE_PROPAGATE_HOSTS and the propagateHosts option to the allowlist', () => {
    active = startTracing('scraper', {
      env: { FC_TRACE_PROPAGATE_HOSTS: 'ingest-server' },
      propagateHosts: ['*.internal'],
    });
    expect(active.state.propagateHosts).toEqual([
      '*.svc.cluster.local', '*.svc', 'localhost', 'ingest-server', '*.internal',
    ]);
  });
});

describe('startTracing with an exporter', () => {
  it('exports redacted spans with the service resource', async () => {
    const exporter = new InMemorySpanExporter();
    active = startTracing('ingest-server', { env: {}, version: '1.9.0', exporter });
    expect(active.state.exporter).toBe('custom');

    inSpan(() => {
      trace.getActiveSpan()?.setAttributes({
        'url.full': 'https://img.store-cdn.example/a.jpg?X-Amz-Signature=abc',
        'url.query': '?X-Amz-Signature=abc',
        'http.request.header.cookie': 'sid=1',
      });
    }, 'GET');
    await active.forceFlush();

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes).toEqual({
      'url.full': 'https://img.store-cdn.example/a.jpg',
      'http.request.header.cookie': '[REDACTED]',
    });
    expect(span.resource.attributes['service.name']).toBe('ingest-server');
    expect(span.resource.attributes['service.version']).toBe('1.9.0');
  });

  it('builds the OTLP/gRPC exporter from the env and reports the endpoint without userinfo', () => {
    active = startTracing('scraper', {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://user:secret@otel-collector.observability:4317' },
    });
    expect(active.state.exporter).toBe('otlp');
    expect(active.state.endpoint).toBe('http://otel-collector.observability:4317/');
  });

  it('does not throw or block when the collector is unreachable, and drops past the queue bound', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    active = startTracing('scraper', {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${closedPort}` },
      batch: { maxQueueSize: 64, maxExportBatchSize: 16, exportTimeoutMillis: 300, scheduledDelayMillis: 60_000 },
    });

    const tracer = trace.getTracer('flood');
    const started = performance.now();
    for (let i = 0; i < 5000; i += 1) {
      tracer.startSpan(`span-${i}`, { kind: SpanKind.INTERNAL }).end();
    }
    const floodMs = performance.now() - started;
    expect(floodMs).toBeLessThan(2000);

    await expect(active.forceFlush()).resolves.toBeUndefined();
    await expect(active.shutdown()).resolves.toBeUndefined();
    active = undefined;
  });
});

describe('ESM loader hook helper', () => {
  it('names the only supported OpenTelemetry ESM hook', () => {
    expect(ESM_LOADER_HOOK).toBe('@opentelemetry/instrumentation/hook.mjs');
  });

  it('resolves the hook file from the app directory (default: cwd)', () => {
    expect(esmLoaderHookPath()).toMatch(/node_modules\/@opentelemetry\/instrumentation\/hook\.mjs$/);
  });

  it('explains what to install when the hook cannot be resolved', () => {
    const empty = mkdtempSync(join(tmpdir(), 'fc-no-otel-'));
    try {
      expect(() => esmLoaderHookPath(empty)).toThrow(/npm install @opentelemetry\/instrumentation/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
