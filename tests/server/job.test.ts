/**
 * runJob(name, fn) for CronJobs (Ross's choice: one trace per ITEM, linked to
 * the run). The run is a root span 'job.<name>' bracketed by job.start and
 * job.end lines; each item the run hands on is its own root trace with a span
 * link and fc.run_id pointing back at the run. Spans are flushed before
 * runJob returns, because a CronJob process exits right after.
 */
import {
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type TracerProvider,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { createLogger } from '../../src/server/log';
import { currentRunId, currentTraceparent, itemContext, runJob, withTraceparent } from '../../src/server/job';
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

  it('treats a blank JOB_NAME as unset', async () => {
    const { logger, parsed } = jobLogger({});
    await runJob('local-run', () => 'done', { logger, env: { JOB_NAME: '   ' } });
    expect(parsed().map((line) => line.job)).toEqual(['local-run', 'local-run']);
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
      expect(item.status.code).toBe(SpanStatusCode.OK);
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

  it('names an item item.enqueue and tags only fc.run_id when given no options', async () => {
    const { logger } = jobLogger();
    await runJob('ingest-crawler', (run) => run.item(() => 'queued'), { logger });
    const item = exporter.getFinishedSpans().find((span) => span.name === 'item.enqueue') as ReadableSpan;
    expect(Object.keys(item.attributes)).toEqual(['fc.run_id']);
  });

  it('runs, logs and returns with no tracing SDK registered at all', async () => {
    await tracing?.shutdown();
    tracing = undefined;
    const { logger, parsed } = jobLogger();
    await expect(runJob('ingest-crawler', (run) => run.item(() => 3), { logger })).resolves.toBe(3);
    expect(parsed().map((line) => [line.event, line.trace_id, line.run_id])).toEqual([
      ['job.start', undefined, undefined],
      ['job.end', undefined, undefined],
    ]);
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

describe('run_id on every line of a run and of its items', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  it("stamps the run's own lines (job.start, mid-run, job.end) with run_id = runId = the run's trace id", async () => {
    const { logger, parsed } = jobLogger();
    const runId = await runJob('ingest-crawler', async (run) => {
      logger.info({ event: 'app.pass' }, 'mid-run');
      await tick();
      logger.info({ event: 'app.pass' }, 'after an await');
      return run.runId;
    }, { logger });

    const lines = parsed();
    expect(lines.map((line) => line.event)).toEqual(['job.start', 'app.pass', 'app.pass', 'job.end']);
    expect(lines.map((line) => line.run_id)).toEqual([runId, runId, runId, runId]);
    expect(lines.map((line) => line.trace_id)).toEqual([runId, runId, runId, runId]);
    expect(runId).toMatch(/^(?!0{32}$)[0-9a-f]{32}$/);
    lines.forEach(expectValidLine);
  });

  it('writes job.end code=error with the run_id too', async () => {
    const { logger, parsed } = jobLogger();
    let runId = '';
    await expect(
      runJob('ingest-crawler', (run) => {
        runId = run.runId;
        throw new Error('store list unavailable');
      }, { logger }),
    ).rejects.toThrow('store list unavailable');
    expect(parsed().map((line) => [line.event, line.run_id])).toEqual([
      ['job.start', runId],
      ['job.end', runId],
    ]);
  });

  it("stamps an item's lines with the run's run_id while trace_id stays the item's own", async () => {
    const { logger, parsed } = jobLogger();
    const seen: Array<{ trace: string; run: string | undefined }> = [];
    const runId = await runJob('ingest-crawler', async (run) => {
      for (const site of ['orzgk', 'amiami']) {
        await run.item(async () => {
          logger.info({ event: 'item.enqueue', site }, 'enqueued');
          seen.push({ trace: trace.getActiveSpan()?.spanContext().traceId as string, run: currentRunId() });
        });
      }
      return run.runId;
    }, { logger });

    const items = parsed().filter((line) => line.event === 'item.enqueue');
    expect(items.map((line) => line.run_id)).toEqual([runId, runId]);
    expect(items.map((line) => line.trace_id)).toEqual(seen.map((item) => item.trace));
    expect(seen.map((item) => item.run)).toEqual([runId, runId]);
    expect(new Set([runId, ...seen.map((item) => item.trace)]).size).toBe(3);
    items.forEach(expectValidLine);
    // The item spans themselves are unchanged: fc.run_id attribute and the link, nothing else.
    for (const span of exporter.getFinishedSpans().filter((s) => s.name === 'item.enqueue')) {
      expect(span.attributes['fc.run_id']).toBe(runId);
      expect(span.links.map((link) => link.context.traceId)).toEqual([runId]);
    }
  });

  it('keeps run_id through nested and concurrent async items, each on its own trace', async () => {
    const { logger, parsed } = jobLogger();
    const runId = await runJob('ingest-crawler', async (run) => {
      await Promise.all(['orzgk', 'amiami', 'gkloot'].map((site) =>
        run.item(async () => {
          await tick();
          logger.info({ event: 'item.enqueue', site }, 'outer');
          await run.item(async () => {
            await tick();
            await Promise.resolve().then(() => logger.info({ event: 'item.process', site, duration_ms: 1 }, 'inner'));
          }, { name: 'item.process' });
          await new Promise<void>((resolve) => setImmediate(() => {
            logger.info({ event: 'app.after', site }, 'after the inner item');
            resolve();
          }));
        }),
      ));
      return run.runId;
    }, { logger });

    const lines = parsed().filter((line) => line.event !== 'job.start' && line.event !== 'job.end');
    expect(lines).toHaveLength(9);
    expect(new Set(lines.map((line) => line.run_id))).toEqual(new Set([runId]));
    const outerTraces = lines.filter((line) => line.event === 'item.enqueue').map((line) => line.trace_id);
    const innerTraces = lines.filter((line) => line.event === 'item.process').map((line) => line.trace_id);
    expect(new Set([runId, ...outerTraces, ...innerTraces]).size).toBe(7);
    for (const site of ['orzgk', 'amiami', 'gkloot']) {
      const outer = lines.find((line) => line.event === 'item.enqueue' && line.site === site);
      const after = lines.find((line) => line.event === 'app.after' && line.site === site);
      expect(after?.trace_id).toBe(outer?.trace_id);
    }
    lines.forEach(expectValidLine);
  });

  it('stamps lines under itemContext (the caller ends the span) with run_id', async () => {
    const { logger, parsed } = jobLogger();
    const runId = await runJob('ingest-crawler', (run) => {
      const item = itemContext(run, { name: 'item.batch' });
      context.with(item.context, () => logger.info({ event: 'item.enqueue' }, 'batched'));
      item.span.end();
      return run.runId;
    }, { logger });
    expect(parsed().find((line) => line.event === 'item.enqueue')?.run_id).toBe(runId);
  });

  it('leaves run_id off lines written after the run returns, and currentRunId undefined outside one', async () => {
    const { logger, parsed } = jobLogger();
    expect(currentRunId()).toBeUndefined();
    await runJob('ingest-crawler', () => undefined, { logger });
    logger.info({ event: 'app.after' }, 'after the run');
    trace.getTracer('q').startActiveSpan('unrelated', (span) => {
      logger.info({ event: 'app.span' }, 'a span, no run');
      expect(currentRunId()).toBeUndefined();
      span.end();
    });
    const outside = parsed().filter((line) => line.event === 'app.after' || line.event === 'app.span');
    expect(outside.map((line) => 'run_id' in line)).toEqual([false, false]);
    expect(currentRunId()).toBeUndefined();
  });

  it('has no run_id when no tracer provider gives the run a real trace id, even with context propagation on', async () => {
    // Shutting tracing down also drops the context manager, which would hide run_id for the wrong reason:
    // keep one, so only the all-zero run trace id stands between the run and its lines.
    await tracing?.shutdown();
    tracing = undefined;
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    try {
      const { logger, parsed } = jobLogger();
      let runId = '';
      const seen = await runJob('ingest-crawler', (run) => {
        runId = run.runId;
        return run.item(() => {
          logger.info({ event: 'item.enqueue' }, 'no provider');
          return currentRunId();
        });
      }, { logger });
      expect(runId).toBe('0'.repeat(32));
      expect(seen).toBeUndefined();
      expect(parsed().map((line) => [line.event, 'run_id' in line])).toEqual([
        ['job.start', false],
        ['item.enqueue', false],
        ['job.end', false],
      ]);
    } finally {
      context.disable();
    }
  });

  it("lets a caller's own run_id win inside a run", async () => {
    const { logger, parsed } = jobLogger();
    await runJob('ingest-crawler', (run) => run.item(() => {
      logger.info({ event: 'app.relay', run_id: 'f'.repeat(32) }, 'relayed');
    }), { logger });
    expect(parsed().find((line) => line.event === 'app.relay')?.run_id).toBe('f'.repeat(32));
  });
});

describe('run_id across a queue: withTraceparent(traceparent, fn, { runId })', () => {
  const RUN_ID = 'c'.repeat(32);

  it('restores the stored run id with the stored trace, after the run has ended', async () => {
    const { logger, parsed } = jobLogger();
    const queued: Array<{ traceparent: string | undefined; runId: string | undefined }> = [];
    const runId = await runJob('ingest-crawler', async (run) => {
      await run.item(() => {
        queued.push({ traceparent: currentTraceparent(), runId: currentRunId() });
      });
      return run.runId;
    }, { logger });

    const [stored] = queued;
    withTraceparent(stored.traceparent, () => logger.info({ event: 'item.process', duration_ms: 1 }, 'worker'), {
      runId: stored.runId,
    });
    const worker = parsed().find((line) => line.event === 'item.process') as Record<string, unknown>;
    expect(stored.runId).toBe(runId);
    expect(worker.run_id).toBe(runId);
    expect(worker.trace_id).toBe(stored.traceparent?.split('-')[1]);
    expectValidLine(worker);
  });

  it("drops the call site's run when no runId is stored, as it drops the call site's trace", async () => {
    const { logger, parsed } = jobLogger();
    const runId = await runJob('ingest-crawler', (run) => {
      withTraceparent(TRACEPARENT, () => logger.info({ event: 'item.process', duration_ms: 1 }, 'in-run worker'));
      withTraceparent('garbage', () => logger.info({ event: 'app.bad_parent' }, 'bad traceparent'));
      logger.info({ event: 'app.after' }, 'back in the run');
      return run.runId;
    }, { logger });
    const lines = parsed();
    const worker = lines.find((line) => line.event === 'item.process') as Record<string, unknown>;
    expect(worker.trace_id).toBe(TRACE_ID);
    expect(worker).not.toHaveProperty('run_id');
    const bad = lines.find((line) => line.event === 'app.bad_parent') as Record<string, unknown>;
    expect(bad).not.toHaveProperty('run_id');
    expect(bad).not.toHaveProperty('trace_id');
    expect(lines.find((line) => line.event === 'app.after')?.run_id).toBe(runId);
  });

  it("does not stamp a worker's run on a producer's item restored without its runId", async () => {
    const { logger, parsed } = jobLogger();
    const stored: string[] = [];
    const producer = await runJob('producer', async (run) => {
      await run.item(() => {
        stored.push(currentTraceparent() as string);
      });
      return run.runId;
    }, { logger });
    const worker = await runJob('worker', (run) => {
      // A 1.8.0-style caller: the traceparent only.
      withTraceparent(stored[0], () => logger.info({ event: 'item.process' }, 'restored'));
      return run.runId;
    }, { logger });

    const line = parsed().find((l) => l.event === 'item.process') as Record<string, unknown>;
    const item = exporter.getFinishedSpans().find((span) => span.spanContext().traceId === line.trace_id);
    expect(item?.attributes['fc.run_id']).toBe(producer);
    expect(producer).not.toBe(worker);
    expect(line).not.toHaveProperty('run_id');
  });

  it('gives a worker started inside a run only the run each entry stored', async () => {
    const { logger, parsed } = jobLogger();
    const queue: Array<{ traceparent?: string; runId?: string } | 'stop'> = [];
    let wake: () => void = () => undefined;
    const next = async () => {
      while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return queue.shift() as (typeof queue)[number];
    };
    let worker: Promise<void> = Promise.resolve();
    const runA = await runJob('runa', async (run) => {
      await run.item(async () => {
        // Started lazily by run A's item: its loop inherits run A's context for good.
        worker = (async () => {
          for (let entry = await next(); entry !== 'stop'; entry = await next()) {
            const { traceparent, runId } = entry;
            withTraceparent(traceparent, () => logger.info({ event: 'item.process' }, 'worker'), { runId });
          }
        })();
        queue.push({ traceparent: currentTraceparent(), runId: currentRunId() });
        wake();
      });
      return run.runId;
    }, { logger });
    // An HTTP handler, in no run, enqueues the next entry.
    const http = trace.getTracer('http').startActiveSpan('POST /enqueue', (span) => {
      queue.push({ traceparent: currentTraceparent(), runId: currentRunId() });
      span.end();
      return span.spanContext().traceId;
    });
    queue.push('stop');
    wake();
    await worker;

    const processed = parsed().filter((line) => line.event === 'item.process');
    expect(processed).toHaveLength(2);
    expect(processed[0].run_id).toBe(runA);
    expect(processed[1].trace_id).toBe(http);
    expect(processed[1]).not.toHaveProperty('run_id');
  });

  it("lets the stored runId win over the call site's run", async () => {
    const { logger, parsed } = jobLogger();
    await runJob('retry-dead-letters', () => {
      withTraceparent(TRACEPARENT, () => logger.info({ event: 'item.process', duration_ms: 1 }, 'retried'), { runId: RUN_ID });
    }, { logger });
    expect(parsed().find((line) => line.event === 'item.process')?.run_id).toBe(RUN_ID);
  });

  it('keeps the run id even when the stored traceparent is unusable, and trims a stored value', () => {
    const { logger, parsed } = jobLogger();
    withTraceparent('garbage', () => logger.info('bad parent'), { runId: ` ${RUN_ID}\n` });
    withTraceparent(null, () => logger.info('no parent'), { runId: RUN_ID });
    expect(parsed().map((line) => [line.run_id, line.trace_id])).toEqual([
      [RUN_ID, undefined],
      [RUN_ID, undefined],
    ]);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['garbage'],
    ['0'.repeat(32)],
    ['C'.repeat(32)],
    ['c'.repeat(31)],
  ])('ignores a stored runId of %p: no run_id outside a run', (value) => {
    const { logger, parsed } = jobLogger();
    const seen = withTraceparent(TRACEPARENT, () => {
      logger.info('worker');
      return currentRunId();
    }, { runId: value as string | null | undefined });
    expect(seen).toBeUndefined();
    expect(parsed()[0]).not.toHaveProperty('run_id');
    expect(parsed()[0].trace_id).toBe(TRACE_ID);
  });

  it.each([
    ['garbage'],
    [12345],
    [{ id: 'c'.repeat(32) }],
    [['c'.repeat(32)]],
    [true],
  ])("ignores a stored runId of %p inside a run: fn runs, no fallback to the call site's run", async (value) => {
    const { logger, parsed } = jobLogger();
    // A queue payload comes back from JSON.parse typed any, so a wrong type still compiles.
    const stored = JSON.parse(JSON.stringify({ traceparent: TRACEPARENT, runId: value }));
    let ran = false;
    await runJob('ingest-crawler', () => {
      withTraceparent(stored.traceparent, () => {
        ran = true;
        logger.info({ event: 'app.worker' }, 'w');
      }, { runId: stored.runId });
    }, { logger });
    expect(ran).toBe(true);
    const line = parsed().find((l) => l.event === 'app.worker') as Record<string, unknown>;
    expect(line.trace_id).toBe(TRACE_ID);
    expect(line).not.toHaveProperty('run_id');
  });

  it('treats options passed as null (a JavaScript caller) as no options', () => {
    const { logger, parsed } = jobLogger();
    const untyped = withTraceparent as unknown as (traceparent: string, fn: () => void, options: null) => void;
    untyped(TRACEPARENT, () => logger.info('worker'), null);
    expect(parsed()[0].trace_id).toBe(TRACE_ID);
    expect(parsed()[0]).not.toHaveProperty('run_id');
  });

  it('without a runId and outside a run, adds no run_id (the 1.8.0 behaviour)', () => {
    const { logger, parsed } = jobLogger();
    withTraceparent(TRACEPARENT, () => logger.info('worker'));
    expect(parsed()[0]).not.toHaveProperty('run_id');
    expect(parsed()[0].trace_id).toBe(TRACE_ID);
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

  it('currentTraceparent is undefined under an all-zero span context, never an all-zero id', () => {
    const value = context.with(trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(INVALID_SPAN_CONTEXT)), () =>
      currentTraceparent(),
    );
    expect(value).toBeUndefined();
  });

  it('withTraceparent accepts a stored value with surrounding whitespace', () => {
    const traceId = withTraceparent(`  ${TRACEPARENT}\n`, () => trace.getActiveSpan()?.spanContext().traceId);
    expect(traceId).toBe(TRACE_ID);
  });

  it('withTraceparent with a bad value also drops the span active at the call site', () => {
    const seen = trace.getTracer('q').startActiveSpan('ambient', (span) => {
      const inner = withTraceparent('garbage', () => trace.getActiveSpan());
      span.end();
      return inner;
    });
    expect(seen).toBeUndefined();
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
