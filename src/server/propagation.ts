/**
 * Propagation allowlist: traceparent and baggage go ONLY to cluster-internal
 * hosts, never to store CDNs or any third party. The list is
 * OTEL_PROPAGATION_ALLOWLIST (lg-logging plan-v2, propagation_and_redaction),
 * default `*.svc.cluster.local,*.svc,localhost`.
 *
 * Why it exists: http and undici auto-instrumentation inject W3C headers into
 * EVERY outbound request, including a scraper's fetches of store pages and
 * image CDNs. That header is an unusual fingerprint to a bot check, and it
 * leaks internal trace ids to someone else's logs.
 *
 * How it decides, fail-closed: the wrapper asks where the request is going.
 *   1. An explicit target set by our own code (withPropagationTarget), e.g. the
 *      Connect client interceptor, which knows its URL.
 *   2. Otherwise the CLIENT span in the context being injected: http and undici
 *      start that span with server.address / url.full BEFORE they inject, so the
 *      target is on it. Older semantic conventions (http.url, net.peer.name,
 *      http.host) are read too. A PRODUCER span counts as well. Any other kind
 *      does not: on a SERVER span, server.address is THIS host, taken from the
 *      caller's Host header, and says nothing about where a request goes next.
 * No target, or a non-recording span with no attributes: nothing is injected.
 * Extraction (inbound) is never restricted.
 *
 * startTracing also makes the http and undici instrumentations skip an
 * off-list host altogether, so such a request gets no auto span either; this
 * propagator stays as the second line for every other path.
 *
 * The run id crosses a process boundary as the W3C baggage entry fc.run_id.
 * RunIdBaggagePropagator bridges that entry and the context key; the W3C
 * baggage propagator, which writes the header, sits INSIDE the allowlist, so
 * the entry goes exactly where traceparent goes. The context key stays the
 * only in-process truth.
 *
 * Depends only on @opentelemetry/api, so the Connect interceptors can use it
 * without pulling in the SDK.
 */
import {
  SpanKind,
  createContextKey,
  propagation,
  type BaggageEntry,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  trace,
} from '@opentelemetry/api';
import { runIdOf, withRunId } from './fields';
import type { Env } from './log';

/** Cluster-internal by construction. Loopback IPs are deliberately NOT listed. */
export const DEFAULT_PROPAGATION_HOSTS: readonly string[] = ['*.svc.cluster.local', '*.svc', 'localhost'];

/**
 * Comma-separated exact names or `*.suffix` patterns. When set (not blank) it
 * IS the list, replacing the defaults; a bare `*` matches nothing. An entry
 * written as a URL or with a port (`http://scraper.fc.svc:3050/`) counts as
 * its host.
 */
export const PROPAGATION_ALLOWLIST_ENV = 'OTEL_PROPAGATION_ALLOWLIST';

const TARGET_KEY = createContextKey('fc-shared propagation target');

function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** The host part of an allowlist entry: a leading scheme, a path and a port dropped. */
function entryHost(entry: string): string {
  return entry
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
}

/** A matcher over exact names and `*.suffix` patterns, case-insensitive. */
export function createHostAllowlist(entries: readonly string[]): (host: string) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const raw of entries) {
    const entry = normaliseHost(entryHost(raw));
    if (entry.startsWith('*.')) {
      if (entry.length > 2) suffixes.push(entry.slice(1));
    } else if (entry !== '') {
      exact.add(entry);
    }
  }
  return (host: string) => {
    const name = normaliseHost(host);
    return exact.has(name) || suffixes.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
  };
}

/** OTEL_PROPAGATION_ALLOWLIST as a list; the defaults when it is unset or blank. */
export function propagationHostsFromEnv(env: Env): string[] {
  const listed = (env[PROPAGATION_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return listed.length > 0 ? listed : [...DEFAULT_PROPAGATION_HOSTS];
}

/** Host of a URL, or of a bare `host[:port]`. Undefined when it cannot be read. */
function hostOf(target: string): string | undefined {
  if (target.includes('://')) {
    try {
      return new URL(target).hostname;
    } catch {
      return undefined;
    }
  }
  const host = target.trim().replace(/:\d+$/, '');
  return host === '' ? undefined : host;
}

/** Mark the outbound target on a context, for code that injects by hand. */
export function withPropagationTarget(ctx: Context, target: string): Context {
  return ctx.setValue(TARGET_KEY, target);
}

/** Span kinds whose attributes name an OUTBOUND target. */
const OUTBOUND_KINDS: ReadonlySet<unknown> = new Set([SpanKind.CLIENT, SpanKind.PRODUCER]);

function attributeTarget(ctx: Context): string | undefined {
  const span = trace.getSpan(ctx) as { kind?: SpanKind; attributes?: Record<string, unknown> } | undefined;
  const attributes = span?.attributes;
  if (attributes === undefined || !OUTBOUND_KINDS.has(span?.kind)) return undefined;
  for (const key of ['server.address', 'url.full', 'http.url', 'net.peer.name', 'http.host']) {
    const value = attributes[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Where an injection in this context is headed, or undefined if unknown. */
export function propagationTargetOf(ctx: Context): string | undefined {
  const explicit = ctx.getValue(TARGET_KEY);
  const target = typeof explicit === 'string' ? explicit : attributeTarget(ctx);
  return target === undefined ? undefined : hostOf(target);
}

/** Injects through `delegate` only when the target host is allowed. */
export class AllowlistPropagator implements TextMapPropagator {
  constructor(
    private readonly delegate: TextMapPropagator,
    private readonly isAllowed: (host: string) => boolean,
  ) {}

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const host = propagationTargetOf(ctx);
    if (host !== undefined && this.isAllowed(host)) this.delegate.inject(ctx, carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.delegate.extract(ctx, carrier, getter);
  }

  fields(): string[] {
    return this.delegate.fields();
  }
}

/** The W3C baggage entry that carries the run id from one process to the next. */
export const RUN_ID_BAGGAGE_KEY = 'fc.run_id';

/** The key of one raw baggage entry, decoded as the W3C parser decodes it; undefined when it cannot be decoded. */
function baggageKeyOf(entry: string): string | undefined {
  try {
    return decodeURIComponent(entry.split(/[=;]/, 1)[0].trim());
  } catch {
    return undefined;
  }
}

/** How many entries of the carrier's raw baggage header(s) name the run id. */
function runIdEntriesIn(header: string | string[] | undefined): number {
  const entries = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',');
  return entries.filter((entry) => baggageKeyOf(entry) === RUN_ID_BAGGAGE_KEY).length;
}

/** The most pairs the W3C baggage injector (@opentelemetry/core) writes; it keeps the first ones. */
const W3C_MAX_PAIRS = 180;
/** The longest pair it writes; it skips a longer one, which takes no slot. */
const W3C_MAX_PAIR_BYTES = 4096;

/** The length of the pair `key=value[;metadata]` as the W3C injector writes it. */
function pairBytes(key: string, entry: BaggageEntry): number {
  const metadata = entry.metadata === undefined ? 0 : 1 + entry.metadata.toString().length;
  return encodeURIComponent(key).length + 1 + encodeURIComponent(entry.value).length + metadata;
}

/**
 * `ctx` with fc.run_id as the FIRST baggage entry, then only the pairs the W3C injector can still write,
 * when it carries a run; with no fc.run_id entry when it does not.
 */
function withRunIdBaggage(ctx: Context): Context {
  const runId = runIdOf(ctx);
  const baggage = propagation.getBaggage(ctx);
  if (runId === undefined) {
    return baggage?.getEntry(RUN_ID_BAGGAGE_KEY) === undefined
      ? ctx
      : propagation.setBaggage(ctx, baggage.removeEntry(RUN_ID_BAGGAGE_KEY));
  }
  // First, so the W3C injector's 180-pair and 8192-byte cuts drop other entries, never this one.
  // Every setEntry copies the baggage, so stop at the pairs the injector writes: copying the
  // rest, which it drops anyway, made a send quadratic in the in-process baggage.
  let bridged = propagation.createBaggage({ [RUN_ID_BAGGAGE_KEY]: { value: runId } });
  let pairs = 1;
  for (const [key, entry] of baggage?.getAllEntries() ?? []) {
    if (pairs === W3C_MAX_PAIRS) break;
    if (key === RUN_ID_BAGGAGE_KEY || pairBytes(key, entry) > W3C_MAX_PAIR_BYTES) continue;
    bridged = bridged.setEntry(key, entry);
    pairs += 1;
  }
  return propagation.setBaggage(ctx, bridged);
}

/**
 * Bridges the run-id context key and the baggage entry fc.run_id around a W3C
 * delegate. It writes no header itself: it only rewrites the context the
 * delegate reads. The delegate's W3C baggage propagator writes the header, and
 * that propagator is what must sit inside AllowlistPropagator
 * (fcTextMapPropagator builds the stack), so the run id goes only where
 * traceparent goes.
 *   inject: the context's run, if any, as the first fc.run_id entry, then only
 *           the pairs the W3C injector writes (the first 179 others of at most
 *           4096 bytes), so a send stays linear in the baggage. Any other
 *           fc.run_id entry (a stale or forged inbound one) is never forwarded.
 *   extract: after the delegate (W3C baggage extraction REPLACES the baggage),
 *           exactly one fc.run_id entry parsed from the carrier, with no
 *           properties and the shape of a trace id (32 lowercase hex, not all
 *           zero), becomes the run; an entry already in the context's baggage
 *           never does. The raw entry is always removed from the baggage.
 * A valid but forged value only mislabels log lines; the trust boundary is the mesh.
 */
export class RunIdBaggagePropagator implements TextMapPropagator {
  constructor(private readonly delegate: TextMapPropagator) {}

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    this.delegate.inject(withRunIdBaggage(ctx), carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const extracted = this.delegate.extract(ctx, carrier, getter);
    const baggage = propagation.getBaggage(extracted);
    const entry = baggage?.getEntry(RUN_ID_BAGGAGE_KEY);
    if (baggage === undefined || entry === undefined) return extracted;
    const stripped = propagation.setBaggage(extracted, baggage.removeEntry(RUN_ID_BAGGAGE_KEY));
    // W3C extraction keeps the context's own baggage when it parses no pair from the carrier,
    // so an unchanged baggage means this entry was already here, not on the wire.
    const fromWire = baggage !== propagation.getBaggage(ctx);
    const single = fromWire && entry.metadata === undefined && runIdEntriesIn(getter.get(carrier, 'baggage')) === 1;
    return single ? withRunId(stripped, entry.value) : stripped;
  }

  fields(): string[] {
    return this.delegate.fields();
  }
}
