/**
 * NODE-ONLY Connect/gRPC interceptors: a span and one log line per call.
 *
 *   SERVER  continues the caller's trace (extracts traceparent, or nests under a
 *           span already active, e.g. http auto-instrumentation on an h1
 *           listener), opens a SERVER span named by the full method, and writes
 *           rpc.in: call, code, duration_ms, peer (l5d-client-id).
 *   CLIENT  opens a CLIENT span, injects traceparent for it (through the
 *           propagation allowlist: only cluster-internal targets get the
 *           header), and writes rpc.out with peer = the target authority.
 *
 * Promoted from fc-coordinator src/connect/interceptors.ts. What that file
 * learned still holds: spans carry OUTCOME ONLY (rpc name, error code), never
 * recordException, because a ConnectError message routinely carries whatever
 * the upstream said. The log line's err is redacted and sanitised.
 *
 * Streaming responses are measured to the end of the stream, so a stream that
 * fails half-way is logged with the failure's code.
 *
 * Start the server OUTSIDE any span: a call arriving while a span is active
 * (e.g. a boot span around listen()) nests under it and ignores the caller's
 * traceparent.
 */
import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Context,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
  type Tracer,
} from '@opentelemetry/api';
import {
  Code,
  ConnectError,
  type Interceptor,
  type StreamRequest,
  type StreamResponse,
  type UnaryRequest,
  type UnaryResponse,
} from '@connectrpc/connect';
import type { Logger, LogLevel } from './log';
import { elapsedMs, hasValidSpan, peerFromHeader } from './fields';
import { withPropagationTarget } from './propagation';

export { peerFromHeader } from './fields';

export const TRACER_NAME = 'fc-shared/connect';

export interface RpcLogOptions {
  logger: Logger;
  /** Default: the global tracer, resolved per call. */
  tracer?: Tracer;
}

// Connect headers are WHATWG Headers: get/set/keys, not property access.
const headersGetter: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};
const headersSetter: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

/** Codes that mean the service (or its dependency) failed, not the caller. */
const SERVER_FAULTS = new Set(['unknown', 'deadline_exceeded', 'unimplemented', 'internal', 'unavailable', 'data_loss']);

/**
 * 'ok' for success, else the Connect code in snake_case ('invalid_argument').
 * A thrown non-Connect error takes `fallback`: a handler's plain Error goes on
 * the wire as internal, so the server side passes Code.Internal to match.
 */
export function codeName(error: unknown, fallback: Code = Code.Unknown): string {
  if (error === undefined) return 'ok';
  return Code[ConnectError.from(error, fallback).code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function levelFor(code: string): LogLevel {
  if (code === 'ok') return 'info';
  return SERVER_FAULTS.has(code) ? 'error' : 'warn';
}

type AnyRequest = UnaryRequest | StreamRequest;
type AnyResponse = UnaryResponse | StreamResponse;
type Outcome = { error: unknown } | undefined;

function rpcAttributes(req: AnyRequest): Record<string, string> {
  return { 'rpc.system': 'connect_rpc', 'rpc.service': req.service.typeName, 'rpc.method': req.method.name };
}

/** Ends the span on the stream's last message, error or early return. */
async function* observed<T>(source: AsyncIterable<T>, finish: (outcome: Outcome) => void): AsyncIterable<T> {
  let outcome: Outcome;
  try {
    yield* source;
  } catch (error) {
    outcome = { error };
    throw error;
  } finally {
    finish(outcome);
  }
}

interface CallRecord {
  event: 'rpc.in' | 'rpc.out';
  /** Code for a thrown non-Connect error. */
  fallback: Code;
  call: string;
  peer: string;
  span: Span;
  ctx: Context;
  logger: Logger;
}

function run(record: CallRecord, invoke: () => Promise<AnyResponse>): Promise<AnyResponse> {
  const startedAt = performance.now();
  const finish = (outcome: Outcome): void => {
    const code = codeName(outcome?.error, record.fallback);
    if (outcome === undefined) {
      record.span.setStatus({ code: SpanStatusCode.OK });
    } else {
      record.span.setStatus({ code: SpanStatusCode.ERROR });
      record.span.setAttribute('rpc.connect_rpc.error_code', code);
    }
    record.span.end();
    context.with(record.ctx, () => {
      record.logger[levelFor(code)](
        {
          event: record.event,
          call: record.call,
          code,
          duration_ms: elapsedMs(startedAt),
          peer: record.peer,
          ...(outcome === undefined ? {} : { err: outcome.error }),
        },
        '',
      );
    });
  };

  return context.with(record.ctx, async () => {
    let res: AnyResponse;
    try {
      res = await invoke();
    } catch (error) {
      finish({ error });
      throw error;
    }
    if (res.stream) return { ...res, message: observed(res.message, finish) };
    finish(undefined);
    return res;
  });
}

/** SERVER interceptor: continue the caller's trace, be a span in it, write rpc.in. */
export function rpcServerInterceptor(options: RpcLogOptions): Interceptor {
  return (next) => (req) => {
    const call = `${req.service.typeName}/${req.method.name}`;
    const active = context.active();
    const parent = hasValidSpan(active) ? active : propagation.extract(active, req.header, headersGetter);
    const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(call, { kind: SpanKind.SERVER, attributes: rpcAttributes(req) }, parent);
    return run(
      {
        event: 'rpc.in',
        fallback: Code.Internal,
        call,
        peer: peerFromHeader(req.header.get('l5d-client-id')),
        span,
        ctx: trace.setSpan(parent, span),
        logger: options.logger,
      },
      () => next(req),
    );
  };
}

/** CLIENT interceptor: be a span, pass traceparent to internal targets, write rpc.out. */
export function rpcClientInterceptor(options: RpcLogOptions): Interceptor {
  return (next) => (req) => {
    const call = `${req.service.typeName}/${req.method.name}`;
    const target = new URL(req.url);
    const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(call, {
      kind: SpanKind.CLIENT,
      attributes: {
        ...rpcAttributes(req),
        'server.address': target.hostname,
        ...(target.port === '' ? {} : { 'server.port': Number(target.port) }),
      },
    });
    const ctx = trace.setSpan(context.active(), span);
    // Injected from THIS span's context, so the header names this hop.
    propagation.inject(withPropagationTarget(ctx, req.url), req.header, headersSetter);
    return run(
      { event: 'rpc.out', fallback: Code.Unknown, call, peer: target.host, span, ctx, logger: options.logger },
      () => next(req),
    );
  };
}
