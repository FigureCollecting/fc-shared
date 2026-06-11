import { trace, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { getTraceContext, getActiveTraceIds } from '../../src/utils/trace';

describe('trace primitive', () => {
  // Real context manager + real wrapped span — exercises the actual path.
  const contextManager = new AsyncLocalStorageContextManager();
  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });
  afterAll(() => {
    context.disable();
    contextManager.disable();
  });

  const TRACE_ID = 'abcdef12345678901234567890abcdef';
  const SPAN_ID = 'fedcba0987654321';
  const withSpan = (fn: () => void): void => {
    const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
    context.with(trace.setSpan(ROOT_CONTEXT, span), fn);
  };

  it('getActiveTraceIds returns the active span ids', () => {
    withSpan(() => {
      expect(getActiveTraceIds()).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
    });
  });

  it('getActiveTraceIds returns undefined with no active span', () => {
    expect(getActiveTraceIds()).toBeUndefined();
  });

  it('getTraceContext formats the canonical tag when a span is active', () => {
    withSpan(() => {
      expect(getTraceContext()).toBe(`trace=${TRACE_ID} span=${SPAN_ID}`);
    });
  });

  it('getTraceContext returns empty string with no active span', () => {
    expect(getTraceContext()).toBe('');
  });
});
