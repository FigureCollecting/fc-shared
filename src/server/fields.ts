/**
 * Internal helpers shared by the ./server/* subpaths. Not an export of the
 * package: the exports map gives no path to this file.
 */
import { isSpanContextValid, trace, type Context } from '@opentelemetry/api';
import { sanitizeLogValue } from '../utils/logger';
import { redactString, type RedactOptions } from '../utils/sanitize';

/** Round a millisecond measurement to 0.1 ms, the precision the log shape uses. */
export function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** Milliseconds since a performance.now() reading, rounded. */
export function elapsedMs(startedAt: number): number {
  return roundMs(Math.max(0, performance.now() - startedAt));
}

/**
 * The log shape's `err`: {type, message}, message redacted and on one line.
 * A thrown non-Error keeps its JS type name so the line still says what it was.
 */
export function errorField(value: unknown, redact?: RedactOptions): { type: string; message: string } {
  if (value instanceof Error) {
    return { type: value.name, message: sanitizeLogValue(redactString(value.message, redact)) };
  }
  const text = typeof value === 'string' ? redactString(value, redact) : value;
  return { type: typeof value, message: sanitizeLogValue(text) };
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
