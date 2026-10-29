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
  baggageEntryMetadataFromString,
  context,
  createTraceState,
  propagation,
  trace,
  type Baggage,
  type BaggageEntry,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import {
  AllowlistPropagator,
  DEFAULT_PROPAGATION_HOSTS,
  PROPAGATION_ALLOWLIST_ENV,
  RUN_ID_BAGGAGE_KEY,
  RunIdBaggagePropagator,
  createHostAllowlist,
  fcTextMapPropagator,
  propagationHostsFromEnv,
  startTracing,
  withPropagationTarget,
  type Tracing,
} from '../../src/server/tracing';
import { runIdOf, withRunId } from '../../src/server/fields';
import { runJob } from '../../src/server/job';
import { createLogger } from '../../src/server/log';
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

  it.each([
    'scraper.fc.svc:3050',
    'http://scraper.fc.svc',
    'https://Scraper.FC.svc:443/ingest',
    ' scraper.fc.svc. ',
    ' http://scraper.fc.svc:3050 ',
    'HTTP://Scraper.fc.svc',
    'scraper.fc.svc?x=1',
    'scraper.fc.svc#frag',
  ])('reads the host of an entry written as %s', (entry) => {
    const matcher = createHostAllowlist([entry]);
    expect(matcher('scraper.fc.svc')).toBe(true);
    expect(matcher('img.store-cdn.example')).toBe(false);
  });

  it('reads the suffix of a wildcard entry written with a scheme or port', () => {
    const matcher = createHostAllowlist(['http://*.svc:8080']);
    expect(matcher('scraper.fc.svc')).toBe(true);
    expect(matcher('svc')).toBe(false);
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
    // One entry is a list too, not a reason to fall back to the defaults.
    expect(propagationHostsFromEnv({ OTEL_PROPAGATION_ALLOWLIST: 'scraper.fc.svc' })).toEqual(['scraper.fc.svc']);
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

describe('fcTextMapPropagator: the run id (fc.run_id) over the wire, inside the allowlist', () => {
  const RUN = '4bf92f3577b34da6a3ce929d0e0e4736';
  const OTHER = 'c'.repeat(32);
  const SCRAPER = 'http://scraper.fc.svc.cluster.local:3050/ingest/scrape';
  let stack: TextMapPropagator;
  beforeAll(() => {
    stack = fcTextMapPropagator(createHostAllowlist(DEFAULT_PROPAGATION_HOSTS));
  });
  const setter: TextMapSetter<Record<string, string>> = {
    set: (carrier, key, value) => {
      carrier[key] = value;
    },
  };
  const getter: TextMapGetter<Record<string, string | string[]>> = {
    get: (carrier, key) => carrier[key],
    keys: (carrier) => Object.keys(carrier),
  };

  function send(ctx: Context, target = SCRAPER): Record<string, string> {
    const carrier: Record<string, string> = {};
    stack.inject(withPropagationTarget(ctx, target), carrier, setter);
    return carrier;
  }

  function receive(headers: Record<string, string | string[]>, into: Context = ROOT_CONTEXT): Context {
    return stack.extract(into, headers, getter);
  }

  function withBaggage(ctx: Context, entries: Record<string, string>): Context {
    const bag = propagation.createBaggage(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { value: v }])));
    return propagation.setBaggage(ctx, bag);
  }

  function baggageOf(ctx: Context): Array<[string, string]> | undefined {
    return propagation.getBaggage(ctx)?.getAllEntries().map(([key, entry]) => [key, entry.value]);
  }

  it('names the baggage key fc.run_id', () => {
    expect(RUN_ID_BAGGAGE_KEY).toBe('fc.run_id');
  });

  it('sends the active run as baggage fc.run_id to an allowed host', () => {
    expect(send(withRunId(ROOT_CONTEXT, RUN))).toEqual({ baggage: `fc.run_id=${RUN}` });
  });

  it('puts fc.run_id first and keeps the baggage already in the context', () => {
    const ctx = withBaggage(withRunId(ROOT_CONTEXT, RUN), { '7': 'numeric-key', tenant: 'fc' });
    expect(send(ctx).baggage).toBe(`fc.run_id=${RUN},7=numeric-key,tenant=fc`);
  });

  it('sends the run from the context, never a different fc.run_id already in the baggage', () => {
    const ctx = withBaggage(withRunId(ROOT_CONTEXT, RUN), { tenant: 'fc', 'fc.run_id': OTHER });
    expect(send(ctx).baggage).toBe(`fc.run_id=${RUN},tenant=fc`);
  });

  it('sends nothing at all, no baggage and no traceparent, to a host off the allowlist', () => {
    const span = trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
    const ctx = withBaggage(trace.setSpan(withRunId(ROOT_CONTEXT, RUN), span), { tenant: 'fc' });
    expect(send(ctx)).toHaveProperty('baggage', `fc.run_id=${RUN},tenant=fc`);
    expect(send(ctx, 'https://img.store-cdn.example/a.jpg')).toEqual({});
    expect(send(ctx, '127.0.0.1:3050')).toEqual({});
  });

  it('sends no fc.run_id when no run is active, even if the baggage carries one', () => {
    expect(send(withBaggage(ROOT_CONTEXT, { 'fc.run_id': OTHER, tenant: 'fc' }))).toEqual({ baggage: 'tenant=fc' });
    expect(send(withBaggage(ROOT_CONTEXT, { 'fc.run_id': OTHER }))).toEqual({});
    expect(send(ROOT_CONTEXT)).toEqual({});
  });

  it('keeps fc.run_id in a baggage header at the W3C limits (180 pairs, 8192 bytes)', () => {
    // 180 pairs of 46 bytes: both the 180-pair cut and the 8192-byte cut drop entries.
    const many = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`k${String(i).padStart(3, '0')}`, 'v'.repeat(41)]));
    const header = send(withBaggage(withRunId(ROOT_CONTEXT, RUN), many)).baggage;
    expect(header.split(',')[0]).toBe(`fc.run_id=${RUN}`);
    expect(header.length).toBeLessThanOrEqual(8192);
    expect(runIdOf(receive({ baggage: header }))).toBe(RUN);
  });

  it('copies only the pairs the W3C injector can write, so a send stays linear in the in-process baggage', () => {
    const ctx = withBaggage(withRunId(ROOT_CONTEXT, RUN), Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, 'v'])));
    const setEntry = jest.spyOn(Object.getPrototypeOf(propagation.createBaggage()) as Baggage, 'setEntry');
    try {
      expect(send(ctx).baggage.split(',')).toEqual([`fc.run_id=${RUN}`, ...Array.from({ length: 179 }, (_, i) => `k${i}=v`)]);
      expect(setEntry.mock.calls.length).toBeLessThanOrEqual(179);
    } finally {
      setEntry.mockRestore();
    }
  });

  it('writes what the W3C injector writes for the whole baggage behind fc.run_id, pairs over 4096 bytes taking no slot', () => {
    const entries: Array<[string, BaggageEntry]> = [
      ['big', { value: 'x'.repeat(5000) }],
      ['edge', { value: 'e'.repeat(4091) }], // edge=eee… is 4096 bytes: written
      ['edge1', { value: 'e'.repeat(4091) }], // 4097 bytes: skipped
      ['euro', { value: '€'.repeat(500) }], // 500 characters, 4500 bytes once encoded
      ['meta', { value: 'v', metadata: baggageEntryMetadataFromString('p'.repeat(4100)) }],
      ['fc.run_id', { value: OTHER }],
      ...Array.from({ length: 200 }, (_, i): [string, BaggageEntry] => [`k${i}`, { value: 'v' }]),
    ];
    let inContext = propagation.createBaggage();
    let whole = propagation.createBaggage({ [RUN_ID_BAGGAGE_KEY]: { value: RUN } });
    for (const [key, entry] of entries) {
      inContext = inContext.setEntry(key, entry);
      if (key !== RUN_ID_BAGGAGE_KEY) whole = whole.setEntry(key, entry);
    }
    const expected: Record<string, string> = {};
    W3C.inject(propagation.setBaggage(ROOT_CONTEXT, whole), expected, setter);
    expect(expected.baggage.split(',')).toHaveLength(180);
    expect(send(propagation.setBaggage(withRunId(ROOT_CONTEXT, RUN), inContext))).toEqual(expected);
  });

  it('receives a valid fc.run_id as the run, with the trace, and strips it from the baggage', () => {
    const ctx = receive({ traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, baggage: `tenant=fc, fc.run_id=${RUN}` });
    expect(runIdOf(ctx)).toBe(RUN);
    expect(trace.getSpanContext(ctx)?.traceId).toBe('a'.repeat(32));
    expect(baggageOf(ctx)).toEqual([['tenant', 'fc']]);
  });

  it('receives fc.run_id that is the only baggage entry, leaving an empty baggage', () => {
    const ctx = receive({ baggage: `fc.run_id=${RUN}` });
    expect(runIdOf(ctx)).toBe(RUN);
    expect(baggageOf(ctx)).toEqual([]);
  });

  it.each([
    ['uppercase hex', RUN.toUpperCase()],
    ['31 hex digits', RUN.slice(1)],
    ['33 hex digits', `${RUN}0`],
    ['all zero', '0'.repeat(32)],
    ['not hex', 'g'.repeat(32)],
    ['an operator label', 'run-1'],
    ['an encoded newline', `${RUN}%0A`],
    ['an encoded space', `%20${RUN}`],
    ['a property', `${RUN};prop`],
    ['a property with a value', `${RUN};ttl=60`],
  ])('rejects and strips fc.run_id with %s', (_name, value) => {
    const ctx = receive({ baggage: `fc.run_id=${value},tenant=fc` });
    expect(runIdOf(ctx)).toBeUndefined();
    expect(baggageOf(ctx)).toEqual([['tenant', 'fc']]);
  });

  it.each([
    ['two baggage headers', { baggage: [`fc.run_id=${RUN}`, `fc.run_id=${OTHER},tenant=fc`] }],
    ['two entries in one header (how node joins repeated headers)', { baggage: `fc.run_id=${RUN}, fc.run_id=${OTHER},tenant=fc` }],
    ['the same entry twice', { baggage: `fc.run_id=${RUN},tenant=fc,fc.run_id=${RUN}` }],
    ['an encoded key beside a plain one', { baggage: `fc%2Erun_id=${OTHER},fc.run_id=${RUN},tenant=fc` }],
  ])('rejects an ambiguous run id (%s) and strips it', (_name, headers) => {
    const ctx = receive(headers);
    expect(runIdOf(ctx)).toBeUndefined();
    expect(baggageOf(ctx)).toEqual([['tenant', 'fc']]);
  });

  it('still reads a valid fc.run_id beside an entry whose key cannot be decoded', () => {
    const ctx = receive({ baggage: `%E0%A4%A=x,fc.run_id=${RUN},tenant=fc` });
    expect(runIdOf(ctx)).toBe(RUN);
    expect(baggageOf(ctx)).toEqual([['tenant', 'fc']]);
  });

  it.each([
    ['no baggage header', {}],
    ['a key with no value', { baggage: 'fc.run_id' }],
    ['an empty value', { baggage: 'fc.run_id=' }],
    ['a value that cannot be decoded', { baggage: 'fc.run_id=%ZZ' }],
    ['a property and no value', { baggage: 'fc.run_id;p=1' }],
    ['an entry over 4096 bytes', { baggage: `fc.run_id=${'a'.repeat(5000)}` }],
  ])('promotes only a run id that came over the wire, never one already in the context baggage (%s)', (_name, headers) => {
    const local = withBaggage(ROOT_CONTEXT, { 'fc.run_id': RUN, tenant: 'fc' });
    const ctx = receive({ traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, ...headers }, local);
    expect(runIdOf(ctx)).toBeUndefined();
    expect(baggageOf(ctx)).toEqual([['tenant', 'fc']]);
  });

  it.each([
    ['an operator label', 'run-1'],
    ['uppercase hex', RUN.toUpperCase()],
    ['all zero', '0'.repeat(32)],
  ])('keeps the run of a context already in one when the inbound fc.run_id is invalid (%s)', (_name, value) => {
    const ctx = receive({ baggage: `fc.run_id=${value},tenant=fc` }, withRunId(ROOT_CONTEXT, OTHER));
    expect(runIdOf(ctx)).toBe(OTHER);
    expect(baggageOf(ctx)).toEqual([['tenant', 'fc']]);
  });

  it('replaces the run of a context already in one with a valid inbound fc.run_id', () => {
    expect(runIdOf(receive({ baggage: `fc.run_id=${RUN}` }, withRunId(ROOT_CONTEXT, OTHER)))).toBe(RUN);
  });

  it('leaves the context alone when nothing names a run', () => {
    expect(baggageOf(receive({}))).toBeUndefined();
    expect(baggageOf(receive({ baggage: 'tenant=fc' }))).toEqual([['tenant', 'fc']]);
    expect(runIdOf(receive({ baggage: 'tenant=fc' }, withRunId(ROOT_CONTEXT, OTHER)))).toBe(OTHER);
  });

  it('does not forward a rejected or ambiguous inbound value on the next hop', () => {
    for (const baggage of [`fc.run_id=run-1,tenant=fc`, `fc.run_id=${RUN},fc.run_id=${OTHER},tenant=fc`]) {
      expect(send(receive({ baggage }))).toEqual({ baggage: 'tenant=fc' });
    }
  });

  it('forwards an accepted inbound run on the next hop, as the run of that request', () => {
    expect(send(receive({ baggage: `tenant=fc,fc.run_id=${RUN}` }))).toEqual({ baggage: `fc.run_id=${RUN},tenant=fc` });
  });

  it('reports the W3C fields', () => {
    expect(stack.fields()).toEqual(['traceparent', 'tracestate', 'baggage']);
  });

  it('RunIdBaggagePropagator bridges around any delegate and reports its fields', () => {
    const seen: Array<string | undefined> = [];
    const delegate: TextMapPropagator = {
      inject: (ctx) => {
        seen.push(propagation.getBaggage(ctx)?.getEntry(RUN_ID_BAGGAGE_KEY)?.value);
      },
      extract: (ctx) => ctx,
      fields: () => ['x-custom'],
    };
    const bridge = new RunIdBaggagePropagator(delegate);
    bridge.inject(withRunId(ROOT_CONTEXT, RUN), {}, setter);
    bridge.inject(ROOT_CONTEXT, {}, setter);
    expect(seen).toEqual([RUN, undefined]);
    expect(bridge.fields()).toEqual(['x-custom']);
  });
});

interface Received {
  traceparent: string | null;
  tracestate: string | null;
  baggage: string | null;
}

/** An upstream tracestate: a request that wrongly carried trace context would carry it too. */
const UPSTREAM_TRACESTATE = 'vendor=state-1';

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
        tracestate: (req.headers.tracestate as string | undefined) ?? null,
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
    const bag = propagation.createBaggage({ tenant: { value: 'fc' } });
    const upstream = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: 1,
      isRemote: true,
      traceState: createTraceState(UPSTREAM_TRACESTATE),
    });
    await tracer.startActiveSpan('parent', {}, upstream, async (span) => {
      await context.with(propagation.setBaggage(context.active(), bag), async () => {
        const response = await fetch(url);
        await response.text();
      });
      span.end();
    });
  }

  it('sends traceparent, tracestate and baggage to localhost', async () => {
    await fetchInSpan(`http://localhost:${port}/allowed?sig=1`);
    expect(received['/allowed'].traceparent).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
    expect(received['/allowed'].tracestate).toBe(UPSTREAM_TRACESTATE);
    expect(received['/allowed'].baggage).toBe('tenant=fc');
  });

  it('sends none of them to a host outside the allowlist and records no client span for it', async () => {
    await fetchInSpan(`http://127.0.0.1:${port}/denied?sig=2`);
    expect(received['/denied']).toEqual({ traceparent: null, tracestate: null, baggage: null });

    await tracing.forceFlush();
    const client = exporter
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.CLIENT)
      .map((span) => [span.attributes['url.full'], span.attributes['url.query']]);
    // Only the allowed request, and without its query.
    expect(client).toEqual([[`http://localhost:${port}/allowed`, undefined]]);
  });

  it("sends a run item's run id as baggage fc.run_id to localhost and no baggage at all to an off-list host", async () => {
    const logger = createLogger({ env: {}, sink: () => undefined });
    const runId = await runJob(
      'propagation-probe',
      (run) =>
        run.item(async () => {
          await (await fetch(`http://localhost:${port}/run-allowed`)).text();
          await (await fetch(`http://127.0.0.1:${port}/run-denied`)).text();
          return run.runId;
        }),
      { logger },
    );
    expect(received['/run-allowed'].baggage).toBe(`fc.run_id=${runId}`);
    expect(received['/run-allowed'].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(received['/run-denied']).toEqual({ traceparent: null, tracestate: null, baggage: null });
  });
});

describe('AllowlistPropagator with real node:http and fetch (child process, built package)', () => {
  const BUILD_BUDGET_MS = 600_000;
  let result: {
    received: Record<string, Received>;
    spans: Array<{ url: string; query: string | null }>;
    runId: string;
    servedRun: Record<string, string | null>;
  };

  beforeAll(() => {
    ensureBuilt();
    const script = `
      const api = require('@opentelemetry/api');
      const { startTracing } = require('@figurecollecting/fc-shared/server/tracing');
      const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
      const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
      const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace');
      const exporter = new InMemorySpanExporter();
      // Nested, as the OpenTelemetry docs pass getNodeAutoInstrumentations() and as a
      // service's src/instrument.mjs will; the flat shape is covered in-process above.
      const tracing = startTracing('propagation-probe', {
        env: {}, exporter, instrumentations: [[new HttpInstrumentation(), new UndiciInstrumentation()]],
      });
      const job = require('@figurecollecting/fc-shared/server/job');
      const { createLogger } = require('@figurecollecting/fc-shared/server/log');
      const http = require('node:http');
      const received = {};
      // The run each request was served in: the http instrumentation extracts the
      // headers into the context the handler runs in, through the global propagator.
      const servedRun = {};
      const server = http.createServer((req, res) => {
        const path = req.url.split('?')[0];
        received[path] = {
          traceparent: req.headers.traceparent || null,
          tracestate: req.headers.tracestate || null,
          baggage: req.headers.baggage || null,
        };
        servedRun[path] = job.currentRunId() || null;
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
        const bag = api.propagation.createBaggage({ tenant: { value: 'fc' } });
        const upstream = api.trace.setSpanContext(api.ROOT_CONTEXT, {
          traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1, isRemote: true,
          traceState: api.createTraceState('${UPSTREAM_TRACESTATE}'),
        });
        await tracer.startActiveSpan('parent', {}, upstream, async (span) => {
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
        // A run, after the spans above are read: one item calls an in-cluster name and a store CDN name.
        const logger = createLogger({ env: {}, sink: () => {} });
        const runId = await job.runJob('propagation-probe', (run) => run.item(async () => {
          await get('scraper.fc.svc.cluster.local', '/run-cluster-local');
          await get('img.store-cdn.example', '/run-store-cdn');
          return run.runId;
        }), { logger });
        server.close();
        await tracing.shutdown();
        console.log(JSON.stringify({ received, spans, runId, servedRun }));
      });
    `;
    result = JSON.parse(runNodeCjs(script)) as typeof result;
  }, BUILD_BUDGET_MS);

  it('carries a run to an in-cluster name as baggage fc.run_id, and the server handler runs in that run', () => {
    expect(result.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.received['/run-cluster-local'].baggage).toBe(`fc.run_id=${result.runId}`);
    expect(result.servedRun['/run-cluster-local']).toBe(result.runId);
  });

  it('sends no baggage to a store CDN name inside a run, so that server sees no run', () => {
    expect(result.received['/run-store-cdn']).toEqual({ traceparent: null, tracestate: null, baggage: null });
    expect(result.servedRun['/run-store-cdn']).toBeNull();
  });

  it('serves a request with no run as no run, and a hand-set baggage entry as plain baggage', () => {
    expect(result.servedRun['/http-localhost']).toBeNull();
    expect(result.received['/http-localhost'].baggage).toBe('tenant=fc');
  });

  it('node:http carries traceparent, tracestate and baggage to localhost, *.svc and *.svc.cluster.local, in one trace', () => {
    const allowed = ['/http-localhost', '/http-svc', '/http-cluster-local'].map((path) => result.received[path]);
    for (const headers of allowed) {
      expect(headers.traceparent).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
      expect(headers.tracestate).toBe(UPSTREAM_TRACESTATE);
      expect(headers.baggage).toBe('tenant=fc');
    }
  });

  it('node:http and fetch send no traceparent, tracestate or baggage to a loopback IP or a store CDN name', () => {
    for (const path of ['/http-loopback-ip', '/http-store-cdn', '/fetch-loopback-ip']) {
      expect({ path, ...result.received[path] }).toEqual({ path, traceparent: null, tracestate: null, baggage: null });
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
