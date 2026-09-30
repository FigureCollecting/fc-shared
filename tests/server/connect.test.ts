/**
 * Connect/gRPC interceptors: one rpc.in line per served call and one rpc.out
 * line per client call (call, code, duration_ms, peer), a SERVER/CLIENT span
 * each, and traceparent carried client -> server on the same trace.
 *
 * Runs over Connect's in-memory router transport, so both interceptors see
 * real Connect requests and errors without a socket. The service descriptor is
 * built from a FileDescriptorProto so no codegen is needed.
 */
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { create, createFileRegistry, type DescService } from '@bufbuild/protobuf';
import {
  FileDescriptorProtoSchema,
  StringValueSchema,
  file_google_protobuf_wrappers,
  type StringValue,
} from '@bufbuild/protobuf/wkt';
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type HandlerContext,
  type Interceptor,
} from '@connectrpc/connect';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { createLogger } from '../../src/server/log';
import { codeName, peerFromHeader, rpcClientInterceptor, rpcServerInterceptor } from '../../src/server/connect';
import { startTracing, type Tracing } from '../../src/server/tracing';
import { captureSink, expectValidLine, type LogLine } from './helpers';

const file = create(FileDescriptorProtoSchema, {
  name: 'fc/test/v1/echo.proto',
  package: 'fc.test.v1',
  syntax: 'proto3',
  dependency: ['google/protobuf/wrappers.proto'],
  service: [
    {
      name: 'EchoService',
      method: [
        { name: 'Echo', inputType: '.google.protobuf.StringValue', outputType: '.google.protobuf.StringValue' },
        {
          name: 'Count',
          inputType: '.google.protobuf.StringValue',
          outputType: '.google.protobuf.StringValue',
          serverStreaming: true,
        },
      ],
    },
  ],
});
const registry = createFileRegistry(file, (name) =>
  name === 'google/protobuf/wrappers.proto' ? file_google_protobuf_wrappers : undefined,
);
const EchoService = registry.getService('fc.test.v1.EchoService') as DescService;

const MESH_ID = 'scraper.fc.serviceaccount.identity.linkerd.app.mesh.estate';
const INTERNAL = 'http://ingest-server.fc.svc:50061';

interface Seen {
  traceparent: string | null;
  traceId?: string;
  spanId?: string;
}

interface EchoClient {
  echo(req: StringValue, options?: { headers?: Record<string, string> }): Promise<StringValue>;
  count(req: StringValue): AsyncIterable<StringValue>;
}

let tracing: Tracing;
let exporter: InMemorySpanExporter;
beforeEach(() => {
  exporter = new InMemorySpanExporter();
  tracing = startTracing('connect-test', { env: {}, exporter });
});
afterEach(async () => {
  await tracing.shutdown();
});

function setup(options: { baseUrl?: string; outer?: Interceptor[]; clientInterceptor?: boolean } = {}) {
  const server = captureSink();
  const client = captureSink();
  const serverLog = createLogger({ service: 'ingest-server', version: '1.9.0', env: {}, sink: server.sink });
  const clientLog = createLogger({ service: 'scraper', version: '2.1.2', env: {}, sink: client.sink });
  const seen: Seen[] = [];

  const record = (ctx: HandlerContext) => {
    const active = trace.getActiveSpan()?.spanContext();
    seen.push({ traceparent: ctx.requestHeader.get('traceparent'), traceId: active?.traceId, spanId: active?.spanId });
  };

  const transport = createRouterTransport(
    (router) => {
      router.service(EchoService, {
        echo: async (req: StringValue, ctx: HandlerContext) => {
          record(ctx);
          if (req.value === 'invalid') throw new ConnectError('bad input', Code.InvalidArgument);
          if (req.value === 'down') throw new ConnectError('spine down', Code.Unavailable);
          if (req.value === 'plain') throw new Error('plain failure');
          return create(StringValueSchema, { value: req.value });
        },
        count: async function* (req: StringValue, ctx: HandlerContext) {
          record(ctx);
          yield create(StringValueSchema, { value: '1' });
          yield create(StringValueSchema, { value: '2' });
          if (req.value === 'fail') throw new ConnectError('stream broke', Code.ResourceExhausted);
          yield create(StringValueSchema, { value: '3' });
        },
      } as never);
    },
    {
      router: { interceptors: [...(options.outer ?? []), rpcServerInterceptor({ logger: serverLog })] },
      transport: {
        baseUrl: options.baseUrl ?? INTERNAL,
        interceptors: options.clientInterceptor === false ? [] : [rpcClientInterceptor({ logger: clientLog })],
      },
    },
  );
  const echo = createClient(EchoService, transport) as unknown as EchoClient;
  return { echo, seen, serverLines: server.parsed, clientLines: client.parsed };
}

const message = (value: string) => create(StringValueSchema, { value });

async function exported(): Promise<ReadableSpan[]> {
  await tracing.forceFlush();
  return exporter.getFinishedSpans();
}

function only(lines: LogLine[]): LogLine {
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe('rpc interceptors: a unary round trip', () => {
  it('carries the caller trace to the server and writes rpc.out and rpc.in lines on it', async () => {
    const { echo, seen, serverLines, clientLines } = setup();
    const caller = await trace.getTracer('caller').startActiveSpan('caller', async (span) => {
      await echo.echo(message('hi'));
      span.end();
      return span.spanContext();
    });

    const out = only(clientLines());
    const inbound = only(serverLines());
    expect(out).toMatchObject({
      level: 'info', service: 'scraper', event: 'rpc.out', call: 'fc.test.v1.EchoService/Echo',
      code: 'ok', peer: 'ingest-server.fc.svc:50061', trace_id: caller.traceId,
    });
    expect(inbound).toMatchObject({
      level: 'info', service: 'ingest-server', event: 'rpc.in', call: 'fc.test.v1.EchoService/Echo',
      code: 'ok', peer: 'unmeshed', trace_id: caller.traceId,
    });
    expect(typeof out.duration_ms).toBe('number');
    expect(typeof inbound.duration_ms).toBe('number');
    expectValidLine(out);
    expectValidLine(inbound);

    expect(seen[0].traceparent).toMatch(new RegExp(`^00-${caller.traceId}-[0-9a-f]{16}-01$`));
    expect(seen[0].traceId).toBe(caller.traceId);

    const spans = await exported();
    const clientSpan = spans.find((span) => span.kind === SpanKind.CLIENT) as ReadableSpan;
    const serverSpan = spans.find((span) => span.kind === SpanKind.SERVER) as ReadableSpan;
    expect(clientSpan.name).toBe('fc.test.v1.EchoService/Echo');
    expect(clientSpan.parentSpanContext?.spanId).toBe(caller.spanId);
    expect(serverSpan.parentSpanContext?.spanId).toBe(clientSpan.spanContext().spanId);
    expect(seen[0].traceparent?.split('-')[2]).toBe(clientSpan.spanContext().spanId);
    expect(seen[0].spanId).toBe(serverSpan.spanContext().spanId);
    expect(serverSpan.attributes).toMatchObject({
      'rpc.system': 'connect_rpc',
      'rpc.service': 'fc.test.v1.EchoService',
      'rpc.method': 'Echo',
    });
    expect(clientSpan.attributes).toMatchObject({ 'server.address': 'ingest-server.fc.svc', 'server.port': 50061 });
    expect(serverSpan.status.code).toBe(SpanStatusCode.OK);
  });

  it('starts a new trace for a call made outside any span, and the server joins it', async () => {
    const { echo, serverLines, clientLines } = setup();
    await echo.echo(message('root'));
    const out = only(clientLines());
    expect(out.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(only(serverLines()).trace_id).toBe(out.trace_id);
  });

  it('extracts traceparent from the request headers when no span is active (a caller in another process)', async () => {
    // The in-memory transport shares one async context between client and server,
    // so without a client interceptor and outside any span the server sees only
    // the header: exactly what a real remote call gives it.
    const { echo, seen, serverLines } = setup({ clientInterceptor: false });
    await echo.echo(message('remote'), { headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` } });
    expect(seen[0].traceId).toBe('1'.repeat(32));
    expect(only(serverLines()).trace_id).toBe('1'.repeat(32));
    const [serverSpan] = await exported();
    expect(serverSpan.kind).toBe(SpanKind.SERVER);
    expect(serverSpan.parentSpanContext).toMatchObject({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), isRemote: true });
  });

  it('takes peer from l5d-client-id, and marks a malformed one invalid', async () => {
    const { echo, serverLines } = setup();
    await echo.echo(message('a'), { headers: { 'l5d-client-id': MESH_ID } });
    await echo.echo(message('b'), { headers: { 'l5d-client-id': 'spoofed "value" with spaces' } });
    expect(serverLines().map((line) => line.peer)).toEqual([MESH_ID, 'invalid']);
  });
});

describe('rpc interceptors: failures', () => {
  it.each([
    ['invalid', 'invalid_argument', 'warn', 'ConnectError'],
    ['down', 'unavailable', 'error', 'ConnectError'],
    // Connect sends a handler's plain Error as internal; both lines must agree.
    ['plain', 'internal', 'error', 'Error'],
  ])('%s -> code %s at level %s on both sides, span status ERROR', async (input, code, level, errType) => {
    const { echo, serverLines, clientLines } = setup();
    await expect(echo.echo(message(input))).rejects.toBeInstanceOf(ConnectError);
    const inbound = only(serverLines());
    const out = only(clientLines());
    expect(inbound).toMatchObject({ event: 'rpc.in', code, level });
    expect(out).toMatchObject({ event: 'rpc.out', code, level });
    expect(inbound.err).toEqual({ type: errType, message: expect.any(String) });
    expect(out.err).toEqual({ type: 'ConnectError', message: expect.any(String) });
    expectValidLine(inbound);
    expectValidLine(out);

    const spans = await exported();
    for (const span of spans) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['rpc.connect_rpc.error_code']).toBe(code);
      expect(span.events).toEqual([]);
    }
  });
});

describe('rpc interceptors: server streaming', () => {
  it('logs once when the stream completes, with the stream outcome', async () => {
    const { echo, serverLines, clientLines } = setup();
    const values: string[] = [];
    for await (const item of echo.count(message('ok'))) values.push(item.value);
    expect(values).toEqual(['1', '2', '3']);
    expect(only(serverLines())).toMatchObject({ event: 'rpc.in', call: 'fc.test.v1.EchoService/Count', code: 'ok' });
    expect(only(clientLines())).toMatchObject({ event: 'rpc.out', call: 'fc.test.v1.EchoService/Count', code: 'ok' });
  });

  it('reports an error raised mid-stream', async () => {
    const { echo, serverLines, clientLines } = setup();
    const values: string[] = [];
    await expect(
      (async () => {
        for await (const item of echo.count(message('fail'))) values.push(item.value);
      })(),
    ).rejects.toBeInstanceOf(ConnectError);
    expect(values).toEqual(['1', '2']);
    expect(only(serverLines())).toMatchObject({ code: 'resource_exhausted', level: 'warn' });
    expect(only(clientLines())).toMatchObject({ code: 'resource_exhausted', level: 'warn' });
  });
});

describe('rpc interceptors: propagation allowlist and span nesting', () => {
  it('sends no traceparent to a target outside the allowlist but still logs and traces the call', async () => {
    const { echo, seen, clientLines } = setup({ baseUrl: 'https://api.store.example' });
    await trace.getTracer('caller').startActiveSpan('caller', async (span) => {
      await echo.echo(message('x'));
      span.end();
    });
    expect(seen[0].traceparent).toBeNull();
    expect(only(clientLines())).toMatchObject({ event: 'rpc.out', peer: 'api.store.example', code: 'ok' });
  });

  it('nests the rpc span under an already-active server span instead of re-extracting', async () => {
    const outer: Interceptor = (next) => async (req) =>
      trace.getTracer('http').startActiveSpan('POST', { kind: SpanKind.SERVER }, async (span) => {
        try {
          return await next(req);
        } finally {
          span.end();
        }
      });
    const { echo } = setup({ outer: [outer] });
    await echo.echo(message('nested'));
    const spans = await exported();
    const httpSpan = spans.find((span) => span.name === 'POST') as ReadableSpan;
    const rpcSpan = spans.find(
      (span) => span.kind === SpanKind.SERVER && span.name === 'fc.test.v1.EchoService/Echo',
    ) as ReadableSpan;
    expect(rpcSpan.parentSpanContext?.spanId).toBe(httpSpan.spanContext().spanId);
    expect(context.active()).toBeDefined();
  });
});

describe('rpc helpers', () => {
  it('names every Connect code in snake_case, ok for success', () => {
    expect(codeName(undefined)).toBe('ok');
    expect(codeName(new ConnectError('x', Code.DeadlineExceeded))).toBe('deadline_exceeded');
    expect(codeName(new ConnectError('x', Code.Unauthenticated))).toBe('unauthenticated');
    expect(codeName(new Error('x'))).toBe('unknown');
    expect(codeName(new Error('x'), Code.Internal)).toBe('internal');
    expect(codeName('text')).toBe('unknown');
  });

  it('validates l5d-client-id as a DNS name', () => {
    expect(peerFromHeader(null)).toBe('unmeshed');
    expect(peerFromHeader('')).toBe('unmeshed');
    expect(peerFromHeader(MESH_ID)).toBe(MESH_ID);
    expect(peerFromHeader('UPPER.case.example')).toBe('upper.case.example');
    expect(peerFromHeader('a'.repeat(300))).toBe('invalid');
    expect(peerFromHeader('has space.example')).toBe('invalid');
  });
});
