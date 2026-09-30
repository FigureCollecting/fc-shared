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
 * Depends only on @opentelemetry/api, so the Connect interceptors can use it
 * without pulling in the SDK.
 */
import {
  SpanKind,
  createContextKey,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  trace,
} from '@opentelemetry/api';
import type { Env } from './log';

/** Cluster-internal by construction. Loopback IPs are deliberately NOT listed. */
export const DEFAULT_PROPAGATION_HOSTS: readonly string[] = ['*.svc.cluster.local', '*.svc', 'localhost'];

/**
 * Comma-separated exact names or `*.suffix` patterns. When set (not blank) it
 * IS the list, replacing the defaults; a bare `*` matches nothing.
 */
export const PROPAGATION_ALLOWLIST_ENV = 'OTEL_PROPAGATION_ALLOWLIST';

const TARGET_KEY = createContextKey('fc-shared propagation target');

function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** A matcher over exact names and `*.suffix` patterns, case-insensitive. */
export function createHostAllowlist(entries: readonly string[]): (host: string) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const raw of entries) {
    const entry = normaliseHost(raw);
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
