/**
 * Shared OpenTelemetry trace-context primitive.
 *
 * This is the foundation every FC service's logger leverages so trace
 * correlation is derived the same way and formatted identically ecosystem-wide —
 * services keep their own logging system and just call these helpers.
 *
 * Depends only on `@opentelemetry/api` (browser-safe, no-op until a host service
 * registers a tracing SDK).
 */
import { trace } from '@opentelemetry/api';

/**
 * The active span's `{ traceId, spanId }`, or `undefined` when there is no active
 * span (no SDK registered, or outside a request). Use this for structured logs
 * that embed the ids as fields.
 */
export function getActiveTraceIds(): { traceId: string; spanId: string } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  // An all-zero traceId is the invalid/unsampled context — treat as none.
  if (!ctx.traceId || /^0+$/.test(ctx.traceId)) return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/**
 * Canonical `trace=<traceId> span=<spanId>` log tag for the active span, or ''
 * when there is none. Append this to a log line so the traceId threads through
 * every service's logs in one parseable format.
 */
export function getTraceContext(): string {
  const ids = getActiveTraceIds();
  return ids ? `trace=${ids.traceId} span=${ids.spanId}` : '';
}
