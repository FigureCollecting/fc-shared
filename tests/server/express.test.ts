/**
 * Express http.in middleware: one line per request with the ROUTE TEMPLATE as
 * call (never the raw URL or its query), the status as code, duration_ms and the
 * caller's mesh identity as peer; the caller's traceparent is continued.
 */
import * as http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { INVALID_SPAN_CONTEXT, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { createLogger } from '../../src/server/log';
import { httpLogMiddleware, routeTemplate } from '../../src/server/express';
import { startTracing, type Tracing } from '../../src/server/tracing';
import { SPAN_ID, TRACEPARENT, TRACE_ID, captureSink, expectValidLine, type LogLine } from './helpers';

const MESH_ID = 'crawler.fc.serviceaccount.identity.linkerd.app.mesh.estate';

let tracing: Tracing;
let exporter: InMemorySpanExporter;
beforeEach(() => {
  exporter = new InMemorySpanExporter();
  tracing = startTracing('express-test', { env: {}, exporter });
});
afterEach(async () => {
  await tracing.shutdown();
});

function app(options: { outerSpan?: boolean; invalidOuterSpan?: boolean } = {}) {
  const capture = captureSink();
  const logger = createLogger({ service: 'scraper', version: '2.1.2', env: {}, sink: capture.sink });
  const handlerIds: Array<{ traceId?: string; spanId?: string }> = [];
  const server = express();

  if (options.outerSpan) {
    server.use((_req: Request, res: Response, next: NextFunction) => {
      trace.getTracer('outer').startActiveSpan('GET', { kind: SpanKind.SERVER }, (span) => {
        res.once('finish', () => span.end());
        next();
      });
    });
  }
  if (options.invalidOuterSpan) {
    server.use((_req: Request, _res: Response, next: NextFunction) => {
      context.with(trace.setSpan(context.active(), trace.wrapSpanContext(INVALID_SPAN_CONTEXT)), () => next());
    });
  }
  server.use(httpLogMiddleware({ logger, ignorePaths: ['/healthz'] }));

  const ingest = express.Router();
  ingest.post('/scrape', async (_req, res) => {
    await Promise.resolve();
    handlerIds.push({ ...trace.getActiveSpan()?.spanContext() });
    res.status(202).json({ queued: true });
  });
  ingest.get('/items/:id', (_req, res) => {
    res.json({ ok: true });
  });
  server.use('/ingest', ingest);
  server.get('/healthz', (_req, res) => {
    res.send('ok');
  });
  server.get('/bad', (_req, res) => {
    res.status(400).json({ error: 'bad request' });
  });
  server.get('/boom', () => {
    throw new Error('handler exploded');
  });
  server.get('/abort', (req) => {
    req.socket.destroy();
  });
  return { server, lines: capture.parsed, handlerIds };
}

function only(lines: LogLine[]): LogLine {
  expect(lines).toHaveLength(1);
  return lines[0];
}

async function spans(): Promise<ReadableSpan[]> {
  await tracing.forceFlush();
  return exporter.getFinishedSpans();
}

describe('httpLogMiddleware', () => {
  it('logs the route template, never the raw URL or query', async () => {
    const { server, lines } = app();
    await request(server).post('/ingest/scrape?token=abc&url=https%3A%2F%2Fx').send({}).expect(202);
    const line = only(lines());
    expect(line).toMatchObject({
      event: 'http.in',
      level: 'info',
      call: 'POST /ingest/scrape',
      code: '202',
      peer: 'unmeshed',
    });
    expect(typeof line.duration_ms).toBe('number');
    expect(JSON.stringify(line)).not.toContain('token');
    expectValidLine(line);
  });

  it('uses the parameterised template for a path with an id', async () => {
    const { server, lines } = app();
    await request(server).get('/ingest/items/123').expect(200);
    expect(only(lines()).call).toBe('GET /ingest/items/:id');
    const [span] = await spans();
    expect(span.name).toBe('GET /ingest/items/:id');
    expect(span.attributes['http.route']).toBe('/ingest/items/:id');
  });

  it("continues the caller's trace: handler, log line and server span all join it", async () => {
    const { server, lines, handlerIds } = app();
    await request(server)
      .post('/ingest/scrape')
      .set('traceparent', TRACEPARENT)
      .set('l5d-client-id', MESH_ID)
      .send({})
      .expect(202);
    const line = only(lines());
    expect(line).toMatchObject({ trace_id: TRACE_ID, peer: MESH_ID });
    expect(handlerIds[0].traceId).toBe(TRACE_ID);

    const [span] = await spans();
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
    expect(line.span_id).toBe(span.spanContext().spanId);
    expect(span.attributes).toMatchObject({ 'http.request.method': 'POST', 'http.response.status_code': 202 });
  });

  it('logs an unmatched route without its path, at warn', async () => {
    const { server, lines } = app();
    await request(server).get('/no/such/thing?x=1').expect(404);
    expect(only(lines())).toMatchObject({ call: 'GET <unmatched>', code: '404', level: 'warn' });
  });

  it('logs a 400 at warn, not info', async () => {
    const { server, lines } = app();
    await request(server).get('/bad').expect(400);
    expect(only(lines())).toMatchObject({ call: 'GET /bad', code: '400', level: 'warn' });
  });

  it('logs a 5xx at error and marks the span failed', async () => {
    const { server, lines } = app();
    await request(server).get('/boom').expect(500);
    expect(only(lines())).toMatchObject({ call: 'GET /boom', code: '500', level: 'error' });
    const [span] = await spans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('skips ignored paths entirely: no line, no span', async () => {
    const { server, lines } = app();
    await request(server).get('/healthz?probe=1').expect(200);
    expect(lines()).toEqual([]);
    expect(await spans()).toEqual([]);
  });

  it('logs a request the client never saw answered as aborted', async () => {
    const { server, lines } = app();
    await expect(request(server).get('/abort')).rejects.toThrow();
    const line = only(lines());
    expect(line).toMatchObject({ call: 'GET /abort', code: '499', aborted: true, level: 'warn' });
    expectValidLine(line);
  });

  it("does not mistake an all-zero active span for a real one: the caller's trace is still extracted", async () => {
    const { server, lines } = app({ invalidOuterSpan: true });
    await request(server).get('/ingest/items/9').set('traceparent', TRACEPARENT).expect(200);
    expect(only(lines()).trace_id).toBe(TRACE_ID);
    const [span] = await spans();
    expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
  });

  it('reuses an already-active server span instead of opening a second one', async () => {
    const { server, lines } = app({ outerSpan: true });
    await request(server).get('/ingest/items/9').expect(200);
    const all = await spans();
    expect(all).toHaveLength(1);
    expect(only(lines()).span_id).toBe(all[0].spanContext().spanId);
  });
});

describe('httpLogMiddleware on a bare node:http server', () => {
  it('works without express: no route template, url instead of originalUrl, default options', async () => {
    const capture = captureSink();
    const logger = createLogger({ service: 'probe', version: '1', env: {}, sink: capture.sink });
    const middleware = httpLogMiddleware({ logger });
    const server = http.createServer((req, res) =>
      middleware(req, res, () => {
        res.statusCode = 204;
        res.end();
      }),
    );
    await request(server).get('/plain?x=1').expect(204);
    expect(only(capture.parsed())).toMatchObject({ event: 'http.in', call: 'GET <unmatched>', code: '204', level: 'info' });
  });
});

describe('routeTemplate', () => {
  it('joins baseUrl and the matched route path, and handles non-string paths', () => {
    expect(routeTemplate({ baseUrl: '/ingest', route: { path: '/scrape' } })).toBe('/ingest/scrape');
    expect(routeTemplate({ route: { path: '/x' } })).toBe('/x');
    expect(routeTemplate({ baseUrl: '', route: { path: /^\/re/ } })).toBe('/^\\/re/');
    expect(routeTemplate({ route: { path: ['/a', '/b'] } })).toBe('/a,/b');
    expect(routeTemplate({ baseUrl: '/x' })).toBeUndefined();
  });
});
