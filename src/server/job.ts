/**
 * NODE-ONLY CronJob helpers (lg-logging tracing_model.cronjobs).
 *
 * runJob(name, fn): the run is a ROOT span 'job.<name>' bracketed by job.start
 * and job.end lines (code ok|error, duration_ms, err on failure). Its failure is
 * rethrown unchanged, so the process exits non-zero exactly as before.
 *
 * One trace per ITEM (Ross's choice): run.item(fn) opens a NEW root trace
 * ('item.enqueue' by default, kind PRODUCER) with a span link and fc.run_id
 * pointing back at the run. One trace per run would put tens of thousands of
 * spans in a single trace. Requests made inside the item carry the item's
 * traceparent (to allowlisted hosts only), so the scraper continues it.
 *
 * Every line written in the run or in one of its items carries run_id, the
 * run's trace id (the context key fc.run_id): run_id finds the whole run,
 * trace_id one item. No SDK (an all-zero run trace id) means no run_id.
 *
 * Spans are flushed before runJob returns: a CronJob process exits right after,
 * and a batch still queued would be lost. A flush failure never masks the
 * job's own result.
 *
 * currentTraceparent / withTraceparent carry a trace across a queue: store the
 * string with the queued item, restore it in the worker. currentRunId, stored
 * next to it and handed back as withTraceparent's runId, carries the run too.
 *
 * Depends only on @opentelemetry/api.
 */
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  diag,
  isSpanContextValid,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import { createLogger, type Env, type Logger } from './log';
import { elapsedMs, runIdOf, withRunId } from './fields';

export const TRACER_NAME = 'fc-shared/job';

export interface ItemOptions {
  /** Span name. Default 'item.enqueue'. */
  name?: string;
  attributes?: Attributes;
}

export interface JobRun {
  readonly name: string;
  /** The run's trace id: what every item's fc.run_id points at. */
  readonly runId: string;
  readonly span: Span;
  readonly tracer: Tracer;
  /** Run fn as its own root trace, linked to this run. Rethrows fn's error. */
  item<T>(fn: () => T | Promise<T>, options?: ItemOptions): Promise<T>;
}

export interface RunJobOptions {
  /** Default: a logger built from `env`. */
  logger?: Logger;
  /** Default: the global tracer. */
  tracer?: Tracer;
  /** Default: process.env. JOB_NAME (downward API) names the Kubernetes Job. */
  env?: Env;
}

/** A new root trace for one item, linked to the run. The caller ends the span. */
export function itemContext(run: JobRun, options: ItemOptions = {}): { context: Context; span: Span } {
  const runContext = run.span.spanContext();
  const span = run.tracer.startSpan(
    options.name ?? 'item.enqueue',
    {
      root: true,
      kind: SpanKind.PRODUCER,
      links: [{ context: runContext }],
      attributes: { ...options.attributes, 'fc.run_id': runContext.traceId },
    },
    ROOT_CONTEXT,
  );
  return { context: trace.setSpan(withRunId(ROOT_CONTEXT, runContext.traceId), span), span };
}

async function runItem<T>(run: JobRun, fn: () => T | Promise<T>, options?: ItemOptions): Promise<T> {
  const item = itemContext(run, options);
  try {
    const result = await context.with(item.context, fn);
    item.span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    item.span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    item.span.end();
  }
}

/** Flush whatever SDK provider is registered; no SDK means nothing to flush. */
async function flushTracing(): Promise<void> {
  const proxy = trace.getTracerProvider() as unknown as { getDelegate(): { forceFlush?: () => Promise<void> } };
  try {
    await proxy.getDelegate().forceFlush?.();
  } catch (error) {
    diag.warn('fc-shared runJob: span flush failed', error);
  }
}

export async function runJob<T>(
  name: string,
  fn: (run: JobRun) => T | Promise<T>,
  options: RunJobOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({ env });
  const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  const k8sJob = env['JOB_NAME']?.trim() || undefined;
  const job = k8sJob ?? name;

  const span = tracer.startSpan(
    `job.${name}`,
    {
      root: true,
      attributes: { 'fc.job.name': name, ...(k8sJob === undefined ? {} : { 'k8s.job.name': k8sJob }) },
    },
    ROOT_CONTEXT,
  );
  const runId = span.spanContext().traceId;
  const runContext = trace.setSpan(withRunId(ROOT_CONTEXT, runId), span);
  const run: JobRun = {
    name,
    runId,
    span,
    tracer,
    item: (itemFn, itemOptions) => runItem(run, itemFn, itemOptions),
  };

  const startedAt = performance.now();
  context.with(runContext, () => logger.info({ event: 'job.start', job }, `${name} started`));
  try {
    const result = await context.with(runContext, () => fn(run));
    span.setStatus({ code: SpanStatusCode.OK });
    context.with(runContext, () =>
      logger.info({ event: 'job.end', job, code: 'ok', duration_ms: elapsedMs(startedAt) }, `${name} finished`),
    );
    return result;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    context.with(runContext, () =>
      logger.error(
        { event: 'job.end', job, code: 'error', duration_ms: elapsedMs(startedAt), err: error },
        `${name} failed`,
      ),
    );
    throw error;
  } finally {
    span.end();
    await flushTracing();
  }
}

/** W3C traceparent of the active span, for storing with a queued item. */
export function currentTraceparent(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext === undefined || !isSpanContextValid(spanContext)) return undefined;
  const flags = spanContext.traceFlags.toString(16).padStart(2, '0');
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

/** The active run's id (runJob, run.item, itemContext, withTraceparent), to store with a queued item's traceparent. */
export function currentRunId(): string | undefined {
  return runIdOf(context.active());
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A version-00 traceparent as a remote span context; undefined if malformed or zero. */
export function parseTraceparent(value: string | null | undefined): SpanContext | undefined {
  const match = TRACEPARENT.exec(value?.trim() ?? '');
  if (match === null) return undefined;
  const spanContext: SpanContext = {
    traceId: match[1],
    spanId: match[2],
    traceFlags: Number.parseInt(match[3], 16),
    isRemote: true,
  };
  return isSpanContextValid(spanContext) ? spanContext : undefined;
}

export interface TraceparentOptions {
  /**
   * The run the stored item belongs to (currentRunId() at enqueue), printed as run_id. Without one that is a real
   * trace id, fn runs in no run.
   */
  runId?: string | null;
}

/**
 * Run fn with a stored traceparent as its parent, so a worker's spans and log
 * lines continue the enqueuer's trace. A missing or malformed value runs fn
 * with no parent at all rather than a broken one. The run comes only from
 * what was stored, like the trace: options.runId when that is a real trace id
 * (kept even when the traceparent is bad), else none, never the call site's.
 * A stored value of the wrong type (a queue payload is JSON) counts as none.
 */
export function withTraceparent<T>(
  traceparent: string | null | undefined,
  fn: () => T,
  options?: TraceparentOptions,
): T {
  const parent = parseTraceparent(traceparent);
  const stored: unknown = options?.runId;
  const run = withRunId(ROOT_CONTEXT, typeof stored === 'string' ? stored.trim() : undefined);
  return context.with(parent === undefined ? run : trace.setSpanContext(run, parent), fn);
}
