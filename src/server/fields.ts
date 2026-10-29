/**
 * Internal helpers shared by the ./server/* subpaths. Not an export of the
 * package: the exports map gives no path to this file.
 */
import { createContextKey, isSpanContextValid, trace, type Context } from '@opentelemetry/api';

/** Round a millisecond measurement to 0.1 ms, the precision the log shape uses. */
export function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** Milliseconds since a performance.now() reading, rounded. */
export function elapsedMs(startedAt: number): number {
  return roundMs(Math.max(0, performance.now() - startedAt));
}

/**
 * The context key for the run a line belongs to: server/job sets it for a run and every item of it, server/log prints
 * it as run_id. createContextKey is Symbol.for, so a CommonJS and an ESM copy of this module share the one key.
 */
const RUN_ID_KEY = createContextKey('fc.run_id');

/** A run id is the run's trace id: 32 lowercase hex, never all zero (no SDK gives the run an all-zero one). */
const RUN_ID = /^(?!0{32}$)[0-9a-f]{32}$/;

/** The run id `ctx` carries, or undefined when it carries none that is a real trace id. */
export function runIdOf(ctx: Context): string | undefined {
  const value = ctx.getValue(RUN_ID_KEY);
  return typeof value === 'string' && RUN_ID.test(value) ? value : undefined;
}

/** `ctx` carrying `runId` when that is a real trace id; `ctx` itself otherwise. */
export function withRunId(ctx: Context, runId: string | null | undefined): Context {
  return typeof runId === 'string' && RUN_ID.test(runId) ? ctx.setValue(RUN_ID_KEY, runId) : ctx;
}

/** True when `ctx` already carries a real span (e.g. one opened by http auto-instrumentation). */
export function hasValidSpan(ctx: Context): boolean {
  const spanContext = trace.getSpanContext(ctx);
  return spanContext !== undefined && isSpanContextValid(spanContext);
}

const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The caller's Linkerd identity from l5d-client-id: 'unmeshed' when absent,
 * 'invalid' when it is not a DNS name. Trustworthy only when the app port is
 * reachable solely through the proxy (Server policy deny-by-default).
 */
export function peerFromHeader(value: string | null | undefined): string {
  const name = value?.trim().toLowerCase() ?? '';
  if (name === '') return 'unmeshed';
  return name.length <= 253 && DNS_NAME.test(name) ? name : 'invalid';
}
