/**
 * Propagation allowlist (lg-logging review, SHOULD: "undici and http inject
 * traceparent into every globalThis.fetch and http request", store CDNs and
 * MFC's image host included; plan-v2 propagation_and_redaction). traceparent
 * and baggage go ONLY to cluster-internal hosts (OTEL_PROPAGATION_ALLOWLIST);
 * a request to any other host gets no trace header AND no auto span.
 *
 * Three layers of proof: the host matcher, the propagator on synthetic
 * contexts, and real requests (fetch in-process; node:http and fetch in a child
 * process against the built package, because jest's module registry hides
 * node:http from require-in-the-middle).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ROOT_CONTEXT,
  SpanKind,
  context,
  propagation,
  trace,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import {
  AllowlistPropagator,
  DEFAULT_PROPAGATION_HOSTS,
  PROPAGATION_ALLOWLIST_ENV,
  createHostAllowlist,
  propagationHostsFromEnv,
  startTracing,
  withPropagationTarget,
  type Tracing,
} from '../../src/server/tracing';
import { ensureBuilt, runNodeCjs } from '../package/package-contract';

const W3C = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

describe('createHostAllowlist', () => {
  const allowed = createHostAllowlist(DEFAULT_PROPAGATION_HOSTS);

  it('defaults to exactly the cluster-internal patterns', () => {
    expect(DEFAULT_PROPAGATION_HOSTS).toEqual(['*.svc.cluster.local', '*.svc', 'localhost']);
  });

  it.each([
    'scraper.fc.svc.cluster.local',
    'authentik-mc-fc-ha.authz.svc.cluster.local',
    'ingest-server.fc.svc',
    'localhost',
    'LOCALHOST',
    'localhost.',
    'Scraper.FC.svc',
  ])('allows %s', (host) => {
    expect(allowed(host)).toBe(true);
  });

  it.each([
    '',
    'svc',
    '.svc',
    'cluster.local',
    'svc.cluster.local',
    '127.0.0.1',
    '[::1]',
    'ingest-server',
    'img.store-cdn.example',
    'localhost.attacker.example',
    'scraper.fc.svc.cluster.local.attacker.example',
    'scraper.fc.svc.attacker.example',
  ])('denies %s', (host) => {
    expect(allowed(host)).toBe(false);
  });

  it('supports exact names and *. suffixes, case-insensitively', () => {
    const custom = createHostAllowlist(['ingest-server', '*.Internal', ' ', '*.']);
    expect(custom('ingest-server')).toBe(true);
    expect(custom('INGEST-SERVER')).toBe(true);
    expect(custom('a.internal')).toBe(true);
    expect(custom('internal')).toBe(false);
    expect(custom('ingest-server.fc')).toBe(false);
  });

  it('never lets a bare wildcard ("*", "*.", "*..") allow a host', () => {
    for (const entries of [['*.'], ['*..'], ['*'], propagationHostsFromEnv({ OTEL_PROPAGATION_ALLOWLIST: '*.,*..,*' })]) {
      const matcher = createHostAllowlist(entries);
      expect(matcher('img.store-cdn.example')).toBe(false);
      expect(matcher('myfigurecollection.net')).toBe(false);
      // A hostname URL accepts; '*..' would otherwise become the suffix '.', which it ends with.
      expect(matcher(new URL('https://img.store-cdn.example../a.jpg').hostname)).toBe(false);
    }
  });

  it('reads the list from OTEL_PROPAGATION_ALLOWLIST; unset or blank means the defaults', () => {
    expect(PROPAGATION_ALLOWLIST_ENV).toBe('OTEL_PROPAGATION_ALLOWLIST');
    expect(propagationHostsFromEnv({ OTEL_PROPAGATION_ALLOWLIST: 'ingest-server.fc.svc, *.internal,,' })).toEqual([
      'ingest-server.fc.svc', '*.internal',
    ]);
    expect(propagationHostsFromEnv({})).toEqual(['*.svc.cluster.local', '*.svc', 'localhost']);
    expect(propagationHostsFromEnv({ OTEL_PROPAGATION_ALLOWLIST: ' , ' })).toEqual(['*.svc.cluster.local', '*.svc', 'localhost']);
    // The pre-plan name is not read.
    expect(propagationHostsFromEnv({ FC_TRACE_PROPAGATE_HOSTS: 'img.store-cdn.example' })).toEqual([
      '*.svc.cluster.local', '*.svc', 'localhost',
    ]);
  });
});

describe('AllowlistPropagator on synthetic contexts', () => {
  const provider = new TracerProvider();
  const tracer = provider.getTracer('unit');
  const propagator = new AllowlistPropagator(W3C, createHostAllowlist(DEFAULT_PROPAGATION_HOSTS));
  const baggage = propagation.createBaggage({ 'fc.run_id': { value: 'run-1' } });

  function injected(ctx = ROOT_CONTEXT, attributes: Record<string, string> = {}): Record<string, string> {
    const span = tracer.startSpan('client', { kind: SpanKind.CLIENT, attributes }, ctx);
    const carrier: Record<string, string> = {};
    propagator.inject(propagation.setBaggage(trace.setSpan(ctx, span), baggage), carrier, {
      set: (c, k, v) => {
        c[k] = v;
      },
    });
    span.end();
    return carrier;
  }

  it('injects traceparent and baggage for an allowed explicit target', () => {
    const carrier = injected(withPropagationTarget(ROOT_CONTEXT, 'http://ingest-server.fc.svc:50061/x.v1.S/M'));
    expect(Object.keys(carrier).sort()).toEqual(['baggage', 'traceparent']);
    expect(carrier.baggage).toBe('fc.run_id=run-1');
  });

  it('injects nothing for a denied explicit target, even if span attributes would allow it', () => {
    const carrier = injected(withPropagationTarget(ROOT_CONTEXT, 'api.store.example:443'), {
      'server.address': 'localhost',
    });
    expect(carrier).toEqual({});
  });

  it.each([
    ['server.address', 'scraper.fc.svc.cluster.local', true],
    ['server.address', 'img.store-cdn.example', false],
    ['url.full', 'http://localhost:3050/lookup', true],
    ['url.full', 'https://img.store-cdn.example/a.jpg', false],
    ['http.url', 'http://ingest-server.fc.svc:50051/', true],
    ['net.peer.name', 'ingest-server.fc.svc', true],
    ['http.host', 'localhost:8080', true],
    ['http.host', 'img.store-cdn.example:443', false],
    ['url.full', 'not a url', false],
    ['url.full', 'http://exa mple/', false],
  ])('reads the target from the client span attribute %s=%s (allowed: %s)', (key, value, allowed) => {
    const carrier = injected(ROOT_CONTEXT, { [key]: value });
    expect('traceparent' in carrier).toBe(allowed);
    expect('baggage' in carrier).toBe(allowed);
  });

  it.each([
    ['SERVER', SpanKind.SERVER],
    ['INTERNAL', SpanKind.INTERNAL],
    ['CONSUMER', SpanKind.CONSUMER],
  ])('ignores target attributes on a %s span: its server.address names this host, not the next hop', (_name, kind) => {
    const span = tracer.startSpan('inbound', { kind, attributes: { 'server.address': 'scraper.fc.svc' } });
    const carrier: Record<string, string> = {};
    propagator.inject(trace.setSpan(ROOT_CONTEXT, span), carrier, { set: (c, k, v) => { c[k] = v; } });
    span.end();
    expect(carrier).toEqual({});
  });

  it('reads the target from a PRODUCER span as from a CLIENT span', () => {
    const span = tracer.startSpan('enqueue', { kind: SpanKind.PRODUCER, attributes: { 'server.address': 'queue.fc.svc' } });
    const carrier: Record<string, string> = {};
    propagator.inject(trace.setSpan(ROOT_CONTEXT, span), carrier, { set: (c, k, v) => { c[k] = v; } });
    span.end();
    expect(carrier).toHaveProperty('traceparent');
  });

  it('fails closed when the target is unknown (no attributes, or a non-recording span)', () => {
    expect(injected()).toEqual({});
    const remote = trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    const carrier: Record<string, string> = {};
    propagator.inject(trace.setSpan(ROOT_CONTEXT, remote), carrier, { set: (c, k, v) => { c[k] = v; } });
    expect(carrier).toEqual({});
  });

  it('always extracts (inbound) and reports the delegate fields', () => {
    const extracted = propagator.extract(
      ROOT_CONTEXT,
      { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
      { get: (c, k) => (c as Record<string, string>)[k], keys: (c) => Object.keys(c as object) },
    );
    expect(trace.getSpanContext(extracted)?.traceId).toBe('a'.repeat(32));
    expect(propagator.fields()).toEqual(W3C.fields());
  });

  it('wraps any delegate propagator', () => {
    const calls: string[] = [];
    const delegate: TextMapPropagator = {
      inject: () => {
        calls.push('inject');
      },
      extract: (ctx) => ctx,
      fields: () => ['x-custom'],
    };
    const wrapped = new AllowlistPropagator(delegate, () => true);
    wrapped.inject(withPropagationTarget(ROOT_CONTEXT, 'anything'), {}, { set: () => undefined });
    expect(calls).toEqual(['inject']);
    expect(wrapped.fields()).toEqual(['x-custom']);
  });
});

interface Received {
  traceparent: string | null;
  baggage: string | null;
}

describe('AllowlistPropagator with real fetch (undici instrumentation, in-process)', () => {
  const exporter = new InMemorySpanExporter();
  const received: Record<string, Received> = {};
  let server: http.Server;
  let port: number;
  let tracing: Tracing;

  beforeAll(async () => {
    tracing = startTracing('propagation-probe', {
      env: {},
      exporter,
      instrumentations: [new UndiciInstrumentation()],
    });
    server = http.createServer((req, res) => {
      received[(req.url ?? '').split('?')[0]] = {
        traceparent: (req.headers.traceparent as string | undefined) ?? null,
        baggage: (req.headers.baggage as string | undefined) ?? null,
      };
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await tracing.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function fetchInSpan(url: string): Promise<void> {
    const tracer = trace.getTracer('probe');
    const bag = propagation.createBaggage({ 'fc.run_id': { value: 'run-1' } });
    await tracer.startActiveSpan('parent', async (span) => {
      await context.with(propagation.setBaggage(context.active(), bag), async () => {
        const response = await fetch(url);
        await response.text();
      });
      span.end();
    });
  }

  it('sends traceparent and baggage to localhost', async () => {
    await fetchInSpan(`http://localhost:${port}/allowed?sig=1`);
    expect(received['/allowed'].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(received['/allowed'].baggage).toBe('fc.run_id=run-1');
  });

  it('sends neither to a host outside the allowlist and records no client span for it', async () => {
    await fetchInSpan(`http://127.0.0.1:${port}/denied?sig=2`);
    expect(received['/denied']).toEqual({ traceparent: null, baggage: null });

    await tracing.forceFlush();
    const client = exporter
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.CLIENT)
      .map((span) => [span.attributes['url.full'], span.attributes['url.query']]);
    // Only the allowed request, and without its query.
    expect(client).toEqual([[`http://localhost:${port}/allowed`, undefined]]);
  });
});

describe('AllowlistPropagator with real node:http and fetch (child process, built package)', () => {
  const BUILD_BUDGET_MS = 600_000;
  let result: { received: Record<string, Received>; spans: Array<{ url: string; query: string | null }> };

  beforeAll(() => {
    ensureBuilt();
    const script = `
      const api = require('@opentelemetry/api');
      const { startTracing } = require('@figurecollecting/fc-shared/server/tracing');
      const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
      const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
      const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace');
      const exporter = new InMemorySpanExporter();
      const tracing = startTracing('propagation-probe', {
        env: {}, exporter, instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
      });
      const http = require('node:http');
      const received = {};
      const server = http.createServer((req, res) => {
        received[req.url.split('?')[0]] = {
          traceparent: req.headers.traceparent || null, baggage: req.headers.baggage || null,
        };
        res.end('ok');
      });
      // Every name resolves to loopback: no request leaves this machine.
      const lookup = (hostname, options, cb) => {
        if (typeof options === 'function') { cb = options; options = {}; }
        if (options && options.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
        else cb(null, '127.0.0.1', 4);
      };
      let port;
      const get = (host, path) => new Promise((resolve, reject) => {
        const req = http.request({ host, port, path, lookup }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end();
      });
      server.listen(0, '127.0.0.1', async () => {
        port = server.address().port;
        const tracer = api.trace.getTracer('probe');
        const bag = api.propagation.createBaggage({ 'fc.run_id': { value: 'run-1' } });
        await tracer.startActiveSpan('parent', async (span) => {
          await api.context.with(api.propagation.setBaggage(api.context.active(), bag), async () => {
            await get('localhost', '/http-localhost?sig=1');
            await get('scraper.fc.svc', '/http-svc');
            await get('scraper.fc.svc.cluster.local', '/http-cluster-local');
            await get('127.0.0.1', '/http-loopback-ip');
            await get('img.store-cdn.example', '/http-store-cdn?sig=abc');
            await (await fetch('http://127.0.0.1:' + port + '/fetch-loopback-ip?sig=3')).text();
          });
          span.end();
        });
        await tracing.forceFlush();
        const spans = exporter.getFinishedSpans()
          .filter((s) => s.kind === api.SpanKind.CLIENT)
          .map((s) => ({ url: s.attributes['url.full'], query: s.attributes['url.query'] ?? null }));
        server.close();
        await tracing.shutdown();
        console.log(JSON.stringify({ received, spans }));
      });
    `;
    result = JSON.parse(runNodeCjs(script)) as typeof result;
  }, BUILD_BUDGET_MS);

  it('node:http carries traceparent and baggage to localhost, *.svc and *.svc.cluster.local, in one trace', () => {
    const allowed = ['/http-localhost', '/http-svc', '/http-cluster-local'].map((path) => result.received[path]);
    for (const headers of allowed) {
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(headers.baggage).toBe('fc.run_id=run-1');
    }
    const traceIds = new Set(allowed.map((headers) => (headers.traceparent as string).split('-')[1]));
    expect(traceIds.size).toBe(1);
  });

  it('node:http and fetch send no trace header to a loopback IP or a store CDN name', () => {
    for (const path of ['/http-loopback-ip', '/http-store-cdn', '/fetch-loopback-ip']) {
      expect({ path, ...result.received[path] }).toEqual({ path, traceparent: null, baggage: null });
    }
  });

  it('records client spans for the allowed hosts only, with no query string exported', () => {
    expect(result.spans.map((span) => new URL(span.url).pathname).sort()).toEqual([
      '/http-cluster-local', '/http-localhost', '/http-svc',
    ]);
    for (const span of result.spans) {
      expect(span.url).not.toContain('?');
      expect(span.query).toBeNull();
    }
  });
});
