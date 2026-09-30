/**
 * NODE-ONLY Express middleware: one http.in line per request.
 *
 *   call         'METHOD /route/template' (req.baseUrl + req.route.path), never
 *                the raw URL or its query; '<unmatched>' when no route matched.
 *   code         the status as a string; '499' when the client went away first.
 *   duration_ms  from the middleware to the response finishing.
 *   peer         l5d-client-id, or 'unmeshed'.
 *
 * Trace: when no span is active the middleware extracts the caller's
 * traceparent and opens a SERVER span (named by the template once known), so
 * the handler and everything it awaits run inside it. When a span is already
 * active (http auto-instrumentation) it is reused, not duplicated.
 *
 * Typed structurally over node:http, so there is no runtime or type dependency
 * on express itself.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SpanKind, SpanStatusCode, context, propagation, trace, type Span, type Tracer } from '@opentelemetry/api';
import type { Logger, LogLevel } from './log';
import { elapsedMs, hasValidSpan, peerFromHeader } from './fields';

export const TRACER_NAME = 'fc-shared/express';

/** What Express sets on a request once a route has matched. */
export interface RouteInfo {
  baseUrl?: string;
  route?: { path?: unknown };
}

export interface HttpLogOptions {
  logger: Logger;
  /** Default: the global tracer, resolved per request. */
  tracer?: Tracer;
  /** Exact paths (no query) that get no line and no span, e.g. probes. */
  ignorePaths?: readonly string[];
}

type RequestLike = IncomingMessage & RouteInfo & { originalUrl?: string };

/** The matched route template, or undefined when nothing matched. */
export function routeTemplate(req: RouteInfo): string | undefined {
  const path = req.route?.path;
  return path === undefined ? undefined : `${req.baseUrl ?? ''}${String(path)}`;
}

function levelFor(status: number): LogLevel {
  if (status >= 500) return 'error';
  return status >= 400 ? 'warn' : 'info';
}

export function httpLogMiddleware(
  options: HttpLogOptions,
): (req: RequestLike, res: ServerResponse, next: (err?: unknown) => void) => void {
  const ignore = new Set(options.ignorePaths ?? []);

  return (req, res, next) => {
    const path = (req.originalUrl ?? req.url ?? '/').split(/[?#]/)[0];
    if (ignore.has(path)) {
      next();
      return;
    }

    const startedAt = performance.now();
    const method = String(req.method);
    const active = context.active();
    const reused = hasValidSpan(active);
    let span: Span | undefined;
    let ctx = active;
    if (!reused) {
      const parent = propagation.extract(active, req.headers);
      const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
      span = tracer.startSpan(method, { kind: SpanKind.SERVER, attributes: { 'http.request.method': method } }, parent);
      ctx = trace.setSpan(parent, span);
    }
    // Node joins a repeated custom header into one string; only set-cookie is an array.
    const peer = peerFromHeader(req.headers['l5d-client-id'] as string | undefined);

    let logged = false;
    const finish = (aborted: boolean): void => {
      if (logged) return;
      logged = true;
      const route = routeTemplate(req);
      const call = `${method} ${route ?? '<unmatched>'}`;
      const status = aborted ? 499 : res.statusCode;
      if (span !== undefined) {
        if (route !== undefined) {
          span.updateName(call);
          span.setAttribute('http.route', route);
        }
        span.setAttribute('http.response.status_code', status);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
      context.with(ctx, () => {
        options.logger[levelFor(status)](
          {
            event: 'http.in',
            call,
            code: String(status),
            duration_ms: elapsedMs(startedAt),
            peer,
            ...(aborted ? { aborted: true } : {}),
          },
          '',
        );
      });
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(!res.writableFinished));

    context.with(ctx, () => next());
  };
}
