import { sanitizeLogValue, configureLogger, createLogger } from '../../src/utils/logger';
import { trace, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

describe('sanitizeLogValue', () => {
  it('stringifies null and undefined explicitly', () => {
    expect(sanitizeLogValue(null)).toBe('null');
    expect(sanitizeLogValue(undefined)).toBe('undefined');
  });

  it('passes strings through unchanged', () => {
    expect(sanitizeLogValue('hello')).toBe('hello');
  });

  it('uses the message of Error instances', () => {
    expect(sanitizeLogValue(new Error('boom'))).toBe('boom');
    expect(sanitizeLogValue(new Error())).toBe('Error (no message)');
  });

  it('JSON-stringifies plain objects', () => {
    expect(sanitizeLogValue({ a: 1 })).toBe('{"a":1}');
  });

  it('falls back to String() for values JSON cannot represent (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sanitizeLogValue(circular)).toBe('[object Object]');
  });

  it('falls back to String() when JSON.stringify yields undefined (a function)', () => {
    const fn = () => 42;
    expect(sanitizeLogValue(fn)).toBe(String(fn));
  });

  it('strips newlines and carriage returns (log-injection defense)', () => {
    const result = sanitizeLogValue('line1\r\nline2\rmore\n');
    expect(result).not.toMatch(/[\r\n]/);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  it('strips ANSI escape codes', () => {
    expect(sanitizeLogValue('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('truncates strings longer than the max length', () => {
    const result = sanitizeLogValue('x'.repeat(2000));
    expect(result.endsWith('...[truncated]')).toBe(true);
    expect(result.length).toBe(1000 + '...[truncated]'.length);
  });
});

describe('Logger', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    configureLogger({ debug: false, level: 'error' });
  });

  it('is silent when debug is disabled', () => {
    configureLogger({ debug: false, level: 'verbose' });
    const log = createLogger('TEST');
    log.verbose('hi');
    log.info('hi');
    log.warn('hi');
    log.error('hi');
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('respects the configured level threshold', () => {
    configureLogger({ debug: true, level: 'warn' });
    const log = createLogger('TEST');
    log.verbose('v');
    log.info('i');
    log.warn('w');
    expect(console.log).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('does not collapse the verbose level (0) to error via falsy coalescing', () => {
    configureLogger({ debug: true, level: 'verbose' });
    const log = createLogger('X');
    log.verbose('v');
    log.info('i');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledTimes(1);
  });

  it('always logs errors when debug is on, regardless of level', () => {
    configureLogger({ debug: true, level: 'error' });
    createLogger('TEST').error('e');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('tags the module and sanitizes the message', () => {
    configureLogger({ debug: true, level: 'verbose' });
    createLogger('API').warn('multi\nline');
    expect(console.warn).toHaveBeenCalledWith('[API]', expect.any(String), 'multi line');
  });

  it('debug() logs when enabled', () => {
    configureLogger({ debug: true, level: 'error' });
    createLogger('X').debug('d');
    expect(console.log).toHaveBeenCalled();
  });
});

describe('Logger trace correlation', () => {
  // A real AsyncLocalStorage context manager + a real wrapped span context — no
  // mocking of the logger, so this exercises the actual correlation path.
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });
  afterAll(() => {
    context.disable();
    contextManager.disable();
  });

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    configureLogger({ debug: true, level: 'error' });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    configureLogger({ debug: false, level: 'error' });
  });

  const TRACE_ID = 'abcdef12345678901234567890abcdef';
  const SPAN_ID = 'fedcba0987654321';

  it('threads trace and span ids into the log line when a span is active', () => {
    const log = createLogger('OTEL');
    const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });

    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      log.error('boom');
    });

    expect(console.error).toHaveBeenCalledTimes(1);
    expect((console.error as jest.Mock).mock.calls[0]).toContain(`trace=${TRACE_ID} span=${SPAN_ID}`);
  });

  it('leaves the log shape unchanged when no span is active', () => {
    const log = createLogger('OTEL');
    log.error('boom');

    const args = (console.error as jest.Mock).mock.calls[0];
    // [OTEL], timestamp, sanitized message — exactly 3 args, no trace tag.
    expect(args).toHaveLength(3);
    expect(args.some((a: unknown) => typeof a === 'string' && a.startsWith('trace='))).toBe(false);
  });
});
