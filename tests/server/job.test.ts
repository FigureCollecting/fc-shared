/**
 * runJob(name, fn) for CronJobs (Ross's choice: one trace per ITEM, linked to
 * the run). The run is a root span 'job.<name>' bracketed by job.start and
 * job.end lines; each item the run hands on is its own root trace with a span
 * link and fc.run_id pointing back at the run. Spans are flushed before
 * runJob returns, because a CronJob process exits right after.
 */
import { SpanKind, SpanStatusCode, context, trace, type TracerProvider } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { createLogger } from '../../src/server/log';
import { currentTraceparent, runJob, withTraceparent } from '../../src/server/job';
import { startTracing, type Tracing } from '../../src/server/tracing';
import { SPAN_ID, TRACEPARENT, TRACE_ID, captureSink, expectValidLine } from './helpers';

let tracing: Tracing | undefined;
let exporter: InMemorySpanExporter;
beforeEach(() => {
  exporter = new InMemorySpanExporter();
  // A long batch delay: spans only reach the exporter if runJob flushes them.
  tracing = startTracing('ingest-crawler', {
    env: {},
    exporter,
    batch: { scheduledDelayMillis: 3_600_000 },
  });
});
afterEach(async () => {
  await tracing?.shutdown();
  tracing = undefined;
});

function jobLogger(env: Record<string, string> = { JOB_NAME: 'ingest-crawler-29312345' }) {
  const capture = captureSink();
  return { logger: createLogger({ service: 'ingest-crawler', version: '2.2.0', env, sink: capture.sink }), ...capture };
}

describe('runJob', () => {
  it('brackets a successful run with job.start and job.end on one root span, flushed before returning', async () => {
    const { logger, parsed } = jobLogger();
    const result = await runJob('ingest-crawler', async (run) => {
      logger.info({ event: 'app.pass', stores: 27 }, 'mid-run');
      expect(run.name).toBe('ingest-crawler');
      return 412;
    }, { logger, env: { JOB_NAME: 'ingest-crawler-29312345' } });

    expect(result).toBe(412);
    const lines = parsed();
    expect(lines.map((line) => line.event)).toEqual(['job.start', 'app.pass', 'job.end']);
    const [start, mid, end] = lines;
    expect(start).toMatchObject({ level: 'info', job: 'ingest-crawler-29312345' });
    expect(end).toMatchObject({ level: 'info', code: 'ok', job: 'ingest-crawler-29312345' });
    expect(typeof end.duration_ms).toBe('number');
    expect(new Set([start.trace_id, mid.trace_id, end.trace_id]).size).toBe(1);
    lines.forEach(expectValidLine);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [runSpan] = spans;
    expect(runSpan.name).toBe('job.ingest-crawler');
    expect(runSpan.parentSpanContext).toBeUndefined();
    expect(runSpan.spanContext().traceId).toBe(start.trace_id);
    expect(runSpan.status.code).toBe(SpanStatusCode.OK);
    expect(runSpan.attributes).toMatchObject({
      'fc.job.name': 'ingest-crawler',
      'k8s.job.name': 'ingest-crawler-29312345',
    });
  });

  it('writes job.end code=error with err, marks the span failed and rethrows the same error', async () => {
    const { logger, parsed } = jobLogger();
    const failure = new Error('store list unavailable');
    await expect(
      runJob('ingest-crawler', async () => {
        throw failure;
      }, { logger }),
    ).rejects.toBe(failure);

    const end = parsed().find((line) => line.event === 'job.end');
    expect(end).toMatchObject({
      level: 'error',
      code: 'error',
      err: { type: 'Error', message: 'store list unavailable' },
    });
    expectValidLine(end);
    const [runSpan] = exporter.getFinishedSpans();
    expect(runSpan.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('treats a synchronous throw exactly like a rejection', async () => {
    const { logger, parsed } = jobLogger();
    await expect(
      runJob('seed', () => {
        throw new TypeError('bad config');
      }, { logger }),
    ).rejects.toThrow('bad config');
    expect(parsed().find((line) => line.event === 'job.end')).toMatchObject({ code: 'error', err: { type: 'TypeError' } });
  });

  it('falls back to the logical name for job when JOB_NAME is unset', async () => {
    const { logger, parsed } = jobLogger({});
    await runJob('local-run', () => 'done', { logger, env: {} });
    expect(parsed().every((line) => line.job === 'local-run')).toBe(true);
    const [runSpan] = exporter.getFinishedSpans();
    expect(runSpan.attributes['k8s.job.name']).toBeUndefined();
  });

  it('gives every item its own root trace, linked to the run and tagged with fc.run_id', async () => {
    const { logger, parsed } = jobLogger();
    const itemIds: string[] = [];
    const runId = await runJob('ingest-crawler', async (run) => {
      for (const site of ['orzgk', 'amiami']) {
        await run.item(async () => {
          logger.debug({ event: 'item.enqueue', site }, 'enqueued');
          logger.info({ event: 'item.enqueue', site }, 'enqueued');
          itemIds.push(trace.getActiveSpan()?.spanContext().traceId as string);
        }, { attributes: { 'fc.site': site } });
      }
      return run.runId;
    }, { logger });

    const spans = exporter.getFinishedSpans();
    const runSpan = spans.find((span) => span.name === 'job.ingest-crawler') as ReadableSpan;
    const items = spans.filter((span) => span.name === 'item.enqueue');
    expect(runId).toBe(runSpan.spanContext().traceId);
    expect(items).toHaveLength(2);
    expect(new Set([runId, ...itemIds]).size).toBe(3);
    for (const item of items) {
      expect(item.parentSpanContext).toBeUndefined();
      expect(item.kind).toBe(SpanKind.PRODUCER);
      expect(item.attributes['fc.run_id']).toBe(runId);
      expect(item.links).toHaveLength(1);
      expect(item.links[0].context.spanId).toBe(runSpan.spanContext().spanId);
      expect(item.links[0].context.traceId).toBe(runId);
    }
    expect(items.map((item) => item.attributes['fc.site'])).toEqual(['orzgk', 'amiami']);
    const itemLines = parsed().filter((line) => line.event === 'item.enqueue');
    expect(itemLines.map((line) => line.trace_id)).toEqual(itemIds);
  });

  it('marks a failed item span as ERROR, rethrows, and lets the run decide', async () => {
    const { logger } = jobLogger();
    const outcome = await runJob('ingest-crawler', async (run) => {
      try {
        await run.item(() => {
          throw new Error('item broke');
        }, { name: 'item.fetch' });
        return 'unreached';
      } catch (err) {
        return (err as Error).message;
      }
    }, { logger });
    expect(outcome).toBe('item broke');
    const item = exporter.getFinishedSpans().find((span) => span.name === 'item.fetch') as ReadableSpan;
    expect(item.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('still returns the job result when flushing the provider fails', async () => {
    await tracing?.shutdown();
    tracing = undefined;
    const real = startTracing('ingest-crawler', { env: {}, exporter });
    const delegate = (trace.getTracerProvider() as unknown as { getDelegate(): TracerProvider }).getDelegate();
    const flaky = {
      getTracer: (name: string, version?: string) => delegate.getTracer(name, version),
      forceFlush: () => Promise.reject(new Error('collector gone')),
    };
    trace.disable();
    trace.setGlobalTracerProvider(flaky as unknown as TracerProvider);
    try {
      const { logger } = jobLogger();
      await expect(runJob('ingest-crawler', () => 7, { logger })).resolves.toBe(7);
    } finally {
      trace.disable();
      await real.shutdown();
    }
  });

  it('writes its lines through a default logger when none is given', async () => {
    const writes: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runJob('defaulted', () => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(writes.map((line) => JSON.parse(line).event)).toEqual(['job.start', 'job.end']);
  });
});

describe('traceparent helpers for queues', () => {
  it('currentTraceparent formats the active span and is undefined without one', () => {
    expect(currentTraceparent()).toBeUndefined();
    const tp = trace.getTracer('q').startActiveSpan('enqueue', (span) => {
      const value = currentTraceparent();
      span.end();
      return { value, ids: span.spanContext() };
    });
    expect(tp.value).toBe(`00-${tp.ids.traceId}-${tp.ids.spanId}-01`);
  });

  it('withTraceparent restores the stored parent so work continues the same trace', () => {
    const child = withTraceparent(TRACEPARENT, () => {
      expect(trace.getActiveSpan()?.spanContext()).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID, isRemote: true });
      return trace.getTracer('worker').startActiveSpan('item.process', { kind: SpanKind.CONSUMER }, (span) => {
        span.end();
        return span;
      });
    });
    expect(child.spanContext().traceId).toBe(TRACE_ID);
    expect((child as unknown as ReadableSpan).parentSpanContext?.spanId).toBe(SPAN_ID);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['garbage'],
    [`00-${'0'.repeat(32)}-${SPAN_ID}-01`],
    [`00-${TRACE_ID}-${'0'.repeat(16)}-01`],
    [`ff-${TRACE_ID}-${SPAN_ID}-01`],
    [`00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
  ])('withTraceparent(%p) runs fn with no parent rather than a broken one', (value) => {
    const seen = context.with(context.active(), () =>
      withTraceparent(value as string | null | undefined, () => trace.getActiveSpan()),
    );
    expect(seen).toBeUndefined();
  });

  it('keeps the sampled flag from the stored traceparent', () => {
    const unsampled = `00-${TRACE_ID}-${SPAN_ID}-00`;
    const flags = withTraceparent(unsampled, () => trace.getActiveSpan()?.spanContext().traceFlags);
    expect(flags).toBe(0);
  });
});
