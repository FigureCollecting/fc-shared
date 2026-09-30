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
import { ROOT_CONTEXT, SpanKind, context, propagation, trace, type TracerProvider as ApiTracerProvider } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { InMemorySpanExporter, TracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace';
import { createLogger } from '../../src/server/log';
import {
  ESM_LOADER_HOOK,
  esmLoaderHookPath,
  resolveTraceEndpoint,
  startTracing,
  withPropagationTarget,
  type Tracing,
} from '../../src/server/tracing';
import { SPAN_ID, TRACEPARENT, TRACE_ID, captureSink } from './helpers';

let active: Tracing | undefined;
afterEach(async () => {
  await active?.shutdown();
  active = undefined;
});

/** Inject for a valid sampled span headed to `target`; the carrier shows what would be sent. */
function injectFor(target: string): Record<string, string> {
  const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
  const carrier: Record<string, string> = {};
  propagation.inject(withPropagationTarget(trace.setSpan(ROOT_CONTEXT, span), target), carrier);
  return carrier;
}

/** An Instrumentation built with enabled:false, recording what registration does to it. */
function probeInstrumentation() {
  const received: ApiTracerProvider[] = [];
  const probe = {
    instrumentationName: 'fc-test/probe',
    instrumentationVersion: '0.0.0',
    enable: jest.fn(),
    disable: jest.fn(),
    setTracerProvider: jest.fn((provider: ApiTracerProvider) => {
      received.push(provider);
    }),
    setMeterProvider: jest.fn(),
    setConfig: jest.fn(),
    getConfig: () => ({ enabled: false }),
  };
  return { probe, instrumentation: probe as unknown as Instrumentation, received };
}

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
    const disableManager = jest.spyOn(AsyncLocalStorageContextManager.prototype, 'disable');
    try {
      const { probe, instrumentation } = probeInstrumentation();
      const first = startTracing('first', { env: {}, instrumentations: [instrumentation] });
      expect(injectFor('http://localhost:3050/lookup')).toHaveProperty('traceparent');
      disableManager.mockClear();
      await first.shutdown();

      expect(probe.disable).toHaveBeenCalledTimes(1);
      expect(disableManager).toHaveBeenCalledTimes(1);
      const orphan = trace.getTracer('after').startSpan('after-shutdown');
      expect(orphan.isRecording()).toBe(false);
      orphan.end();
      expect(inSpan(() => trace.getActiveSpan())).toBeUndefined();
      // Even an allowlisted target gets nothing: the propagator is gone too.
      expect(injectFor('http://localhost:3050/lookup')).toEqual({});

      active = startTracing('second', { env: {} });
      expect(active).not.toBe(first);
      expect(active.state.service).toBe('second');
    } finally {
      disableManager.mockRestore();
    }
  });

  it('registers the given instrumentations against its own provider, enabling one built disabled', async () => {
    const exporter = new InMemorySpanExporter();
    const { probe, instrumentation, received } = probeInstrumentation();
    active = startTracing('scraper', { env: {}, exporter, instrumentations: [instrumentation] });
    expect(probe.enable).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    received[0].getTracer('probe').startSpan('from-instrumentation').end();
    await active.forceFlush();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['from-instrumentation']);
  });

  it('takes the allowlist from OTEL_PROPAGATION_ALLOWLIST and adds the propagateHosts option', () => {
    active = startTracing('scraper', {
      env: { OTEL_PROPAGATION_ALLOWLIST: '*.svc, ingest-server' },
      propagateHosts: ['*.internal'],
    });
    expect(active.state.propagateHosts).toEqual(['*.svc', 'ingest-server', '*.internal']);
    expect(injectFor('ingest-server')).toHaveProperty('traceparent');
    expect(injectFor('a.internal')).toHaveProperty('traceparent');
    // Replaced, not extended: a default the list left out gets nothing.
    expect(injectFor('scraper.fc.svc.cluster.local')).toEqual({});
  });

  it('makes http and undici instrumentation skip every off-list host, keeps the caller\'s own ignore hook, and restores it on shutdown', async () => {
    const ownHttp = jest.fn((request: { path?: string | null }) => request.path === '/own-skip');
    const ownUndici = jest.fn((request: { path: string }) => request.path === '/own-skip');
    const http = new HttpInstrumentation({ ignoreOutgoingRequestHook: ownHttp });
    const undici = new UndiciInstrumentation({ ignoreRequestHook: ownUndici as never });
    const bare = new UndiciInstrumentation();
    const { probe, instrumentation: other } = probeInstrumentation();
    active = startTracing('scraper', { env: {}, instrumentations: [http, undici, bare, other] });

    const skipHttp = http.getConfig().ignoreOutgoingRequestHook as (request: object) => boolean;
    expect(
      [
        { hostname: 'scraper.fc.svc', path: '/' },
        { host: 'ingest-server.fc.svc.cluster.local:8080', path: '/' },
        { path: '/' }, // node's default host: localhost
        { hostname: 'localhost', path: '/own-skip' },
        { hostname: 'img.store-cdn.example', path: '/a.jpg' },
        { host: '127.0.0.1:443', path: '/' },
        { host: '[::1]:80', path: '/' },
        { hostname: '', host: '', path: '/' },
      ].map(skipHttp),
    ).toEqual([false, false, false, true, true, true, true, false]);
    // Off-list is decided first; the caller's hook is asked only about allowed hosts.
    expect(ownHttp.mock.calls.map(([request]) => request.path)).toEqual(['/', '/', '/', '/own-skip', '/']);

    const skipUndici = undici.getConfig().ignoreRequestHook as (request: object) => boolean;
    expect(
      [
        { origin: 'http://scraper.fc.svc:3050', path: '/' },
        { origin: 'http://localhost:1', path: '/own-skip' },
        { origin: 'https://img.store-cdn.example', path: '/a.jpg' },
        { origin: 'http://127.0.0.1:9', path: '/' },
        { origin: 'not a url', path: '/' },
        { path: '/' },
      ].map(skipUndici),
    ).toEqual([false, true, true, true, true, true]);
    expect(ownUndici).toHaveBeenCalledTimes(2);
    const skipBare = bare.getConfig().ignoreRequestHook as (request: object) => boolean;
    expect([{ origin: 'http://localhost:1', path: '/' }, { origin: 'https://img.store-cdn.example', path: '/' }].map(skipBare))
      .toEqual([false, true]);
    // Only http and undici are touched.
    expect(probe.setConfig).not.toHaveBeenCalled();

    await active.shutdown();
    active = undefined;
    expect(http.getConfig().ignoreOutgoingRequestHook).toBe(ownHttp);
    expect(undici.getConfig().ignoreRequestHook).toBe(ownUndici);
    expect(bare.getConfig().ignoreRequestHook).toBeUndefined();
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

  it('does not throw or block when the collector refuses connections', async () => {
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

  it('bounds forceFlush AND shutdown by exportTimeoutMillis when the collector accepts and never answers', async () => {
    const DEADLINE_MS = 400;
    const SLACK_MS = 400;
    const sockets: net.Socket[] = [];
    const blackHole = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    const { port } = blackHole.address() as net.AddressInfo;
    try {
      active = startTracing('scraper', {
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` },
        batch: { exportTimeoutMillis: DEADLINE_MS },
      });
      inSpan(() => undefined);
      let started = performance.now();
      await active.forceFlush();
      const flushMs = performance.now() - started;
      started = performance.now();
      await active.shutdown();
      active = undefined;
      const shutdownMs = performance.now() - started;

      expect(sockets.length).toBeGreaterThan(0);
      // The flush gives up at the deadline. The OTLP call has the SAME deadline, so it is over by
      // then and shutdown has nothing left to wait for; a longer exporter deadline would hold it.
      expect({ flushMs: Math.round(flushMs), shutdownMs: Math.round(shutdownMs) }).toEqual({
        flushMs: expect.toBeWithin(0, DEADLINE_MS + SLACK_MS),
        shutdownMs: expect.toBeWithin(0, SLACK_MS),
      });
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => blackHole.close(resolve));
    }
  }, 20_000);

  it('waits at most exportTimeoutMillis, 10 s by default, for an export that never answers', async () => {
    const neverAnswers: SpanExporter = { export: () => undefined, shutdown: () => Promise.resolve() };
    jest.useFakeTimers();
    try {
      active = startTracing('scraper', { env: {}, exporter: neverAnswers });
      inSpan(() => undefined);
      let settled = false;
      const flushed = active.forceFlush().then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await flushed;
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['the default bound (2048 queued, 512 per batch)', undefined, 2048 + 512],
    ['a configured bound', { maxQueueSize: 64, maxExportBatchSize: 16 }, 64 + 16],
  ])('drops spans past %s rather than queueing without limit', async (_label, batch, most) => {
    const exporter = new InMemorySpanExporter();
    active = startTracing('scraper', { env: {}, exporter, ...(batch === undefined ? {} : { batch }) });
    const tracer = trace.getTracer('flood');
    for (let i = 0; i < 5000; i += 1) {
      tracer.startSpan(`span-${i}`).end();
    }
    await active.forceFlush();
    const exported = exporter.getFinishedSpans().length;
    expect(exported).toBeGreaterThan(0);
    expect(exported).toBeLessThanOrEqual(most);
  });
});

describe('startTracing when another OpenTelemetry setup registered first', () => {
  afterEach(() => {
    context.disable();
    propagation.disable();
    trace.disable();
  });

  it('throws naming the taken globals, rolls back its own, and leaves the other setup untouched', async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(new TracerProvider());
    const exporter = new InMemorySpanExporter();
    const exporterShutdown = jest.spyOn(exporter, 'shutdown');
    const undici = new UndiciInstrumentation();

    expect(() => startTracing('scraper', { env: {}, exporter, instrumentations: [undici] })).toThrow(
      /OpenTelemetry globals already registered: propagation, trace/,
    );
    // Nothing of its own is left behind on the instrumentations either.
    expect(undici.getConfig().ignoreRequestHook).toBeUndefined();
    undici.disable();
    // Its own context manager was released again, and its provider shut down...
    expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exporterShutdown).toHaveBeenCalledTimes(1);
    // ...while the other setup keeps its globals and works as it did (it would have leaked either way).
    expect(trace.setGlobalTracerProvider(new TracerProvider())).toBe(false);
    expect(injectFor('https://img.store-cdn.example/a.jpg')).toEqual({ traceparent: TRACEPARENT });
  });

  it('throws when only the context manager is taken, releasing its propagator and provider', () => {
    const foreign = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(foreign);
    const disableManager = jest.spyOn(AsyncLocalStorageContextManager.prototype, 'disable');
    try {
      expect(() => startTracing('scraper', { env: {} })).toThrow(/OpenTelemetry globals already registered: context$/);
      // Its own, never-registered manager is disabled; the other setup's is not touched.
      expect(disableManager).toHaveBeenCalledTimes(1);
      expect(disableManager.mock.contexts[0]).not.toBe(foreign);
    } finally {
      disableManager.mockRestore();
    }
    expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager())).toBe(false);
    expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
    expect(trace.setGlobalTracerProvider(new TracerProvider())).toBe(true);
  });

  it('starts normally once the other setup is gone', async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    expect(() => startTracing('scraper', { env: {} })).toThrow(/propagation/);
    propagation.disable();

    const tracing = startTracing('scraper', { env: {} });
    try {
      expect(injectFor('https://img.store-cdn.example/a.jpg')).toEqual({});
      expect(injectFor('http://scraper.fc.svc:3050/lookup')).toEqual({ traceparent: TRACEPARENT });
    } finally {
      await tracing.shutdown();
    }
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
