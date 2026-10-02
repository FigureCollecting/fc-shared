/**
 * ./server/log: the estate's one log shape (lg-logging plan, log_shape).
 *
 * Every assertion is on the LINE as a collector would read it: one JSON object,
 * no newline inside it, reserved keys typed and in contract order, trace ids
 * present only under a real span. The schema check uses the published file.
 */
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import {
  RESERVED_LOG_KEYS,
  createLogger,
  installConsoleBridge,
  resolveServiceIdentity,
  toSnakeCase,
  type Logger,
} from '../../src/server/log';
import * as sanitize from '../../src/utils/sanitize';
import { SPAN_ID, TRACE_ID, captureSink, expectValidLine, withRemoteSpan } from './helpers';

const contextManager = new AsyncLocalStorageContextManager();
beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
});
afterAll(() => {
  context.disable();
  contextManager.disable();
});

const BASE = { service: 'ingest-server', version: '1.9.0', env: {} };
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function logger(extra: Record<string, unknown> = {}) {
  const capture = captureSink();
  const log = createLogger({ ...BASE, sink: capture.sink, ...extra });
  return { log, ...capture };
}

describe('server log line shape', () => {
  it('reproduces the plan example_rpc_in: reserved keys in contract order, then event fields', () => {
    const { log, lines, parsed } = logger();
    withRemoteSpan(() => {
      log.info(
        {
          event: 'rpc.in',
          call: 'ingest.v1.SpineIngest/Ingest',
          code: 'ok',
          duration_ms: 41.23,
          peer: 'scraper.fc.serviceaccount.identity.linkerd.app.mesh.estate',
          site: 'orzgk',
          claims: 23,
        },
        '',
      );
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const [line] = parsed();
    expect(Object.keys(line)).toEqual([
      'time', 'level', 'service', 'version', 'event', 'msg', 'call', 'code',
      'duration_ms', 'peer', 'trace_id', 'span_id', 'site', 'claims',
    ]);
    expect(line).toMatchObject({
      level: 'info',
      service: 'ingest-server',
      version: '1.9.0',
      event: 'rpc.in',
      msg: '',
      call: 'ingest.v1.SpineIngest/Ingest',
      code: 'ok',
      duration_ms: 41.2,
      peer: 'scraper.fc.serviceaccount.identity.linkerd.app.mesh.estate',
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      site: 'orzgk',
      claims: 23,
    });
    expect(line.time).toMatch(ISO_MS);
    expectValidLine(line);
  });

  it('leaves trace_id and span_id ABSENT, never zeroed, when no span is active', () => {
    const { log, parsed } = logger();
    log.info('no span here');
    const [line] = parsed();
    expect(line).not.toHaveProperty('trace_id');
    expect(line).not.toHaveProperty('span_id');
    expectValidLine(line);
  });

  it('treats an all-zero span context as no span', () => {
    const { log, parsed } = logger();
    withRemoteSpan(() => log.info('invalid context'), '0'.repeat(32), '0'.repeat(16));
    expect(parsed()[0]).not.toHaveProperty('trace_id');
  });

  it('defaults event to app.log and msg to the empty string', () => {
    const { log, parsed } = logger();
    log.info({ site: 'orzgk' });
    const [line] = parsed();
    expect(line).toMatchObject({ event: 'app.log', msg: '', site: 'orzgk' });
    expectValidLine(line);
  });

  it('accepts the pino call shapes: (msg), (obj, msg), (err, msg) and trailing args', () => {
    const { log, parsed } = logger();
    log.info('plain message');
    log.info({ site: 'a' }, 'with fields');
    log.error(new TypeError('boom'), 'failed hard');
    log.warn('several', 'parts', 3);
    log.error(new RangeError('only an error'));
    const lines = parsed();
    expect(lines.map((line) => line.msg)).toEqual([
      'plain message', 'with fields', 'failed hard', 'several parts 3', 'only an error',
    ]);
    expect(lines[2].err).toEqual({ type: 'TypeError', message: 'boom' });
    expect(lines[4].err).toEqual({ type: 'RangeError', message: 'only an error' });
    lines.forEach(expectValidLine);
  });

  it('types the reserved fields: code becomes a string, junk durations drop, call never keeps a query', () => {
    const { log, parsed } = logger();
    log.info({
      event: 'http.in',
      call: 'POST /ingest/scrape?token=abc#frag',
      code: 202,
      duration_ms: 'slow',
      queue_ms: 12.345,
      peer: 'unmeshed',
    });
    const [line] = parsed();
    expect(line.call).toBe('POST /ingest/scrape');
    expect(line.code).toBe('202');
    expect(line).not.toHaveProperty('duration_ms');
    expect(line.queue_ms).toBe(12.3);
  });

  it('drops negative timings, cuts call at a fragment too, and keeps peer on one line', () => {
    const { log, parsed } = logger();
    log.info({ event: 'app.timing', call: 'GET /a#frag', duration_ms: -5, queue_ms: -1, peer: 'forged\npeer' });
    const [line] = parsed();
    expect(line.call).toBe('GET /a');
    expect(line).not.toHaveProperty('duration_ms');
    expect(line).not.toHaveProperty('queue_ms');
    expect(line.peer).toBe('forged peer');
    expectValidLine(line);
  });

  it('logs an array first argument as message text, not as fields', () => {
    const { log, parsed } = logger();
    log.info(['a', 'b'], 'x');
    const [line] = parsed();
    expect(line.msg).toBe('["a","b"] x');
    expect(line).not.toHaveProperty('f_0');
  });

  it('keeps a non-finite number readable instead of letting JSON turn it into null', () => {
    const { log, parsed } = logger();
    log.info({ ratio: Number.NaN, ceiling: Number.POSITIVE_INFINITY });
    expect(parsed()[0]).toMatchObject({ ratio: 'NaN', ceiling: 'Infinity' });
  });

  it('walks an object field at most four levels deep', () => {
    const { log, parsed } = logger();
    log.info({ deep: { a: { b: { c: { d: { e: 1 } } } } } });
    expect(parsed()[0].deep).toBe('{"a":{"b":{"c":{"d":"[truncated:max-depth]"}}}}');
  });

  it('maps camelCase reserved spellings onto the reserved keys', () => {
    const { log, parsed } = logger();
    log.info({ event: 'job.end', code: 'ok', durationMs: 671000, queueMs: 5 });
    const [line] = parsed();
    expect(line.duration_ms).toBe(671000);
    expect(line.queue_ms).toBe(5);
    expect(line).not.toHaveProperty('durationMs');
    expectValidLine(line);
  });

  it('normalises other keys to snake_case and flattens nested values to one-line JSON', () => {
    const { log, parsed } = logger();
    log.info({
      itemId: 'abc',
      'HTTP-Status': 200,
      nested: { a: { b: [1, 2] } },
      list: ['x', 'y'],
      when: new Date('2026-09-30T01:02:03.456Z'),
      big: BigInt(7),
      nothing: null,
      skipped: undefined,
      callback: () => undefined,
    });
    const [line] = parsed();
    expect(line).toMatchObject({
      item_id: 'abc',
      http_status: 200,
      nested: '{"a":{"b":[1,2]}}',
      list: '["x","y"]',
      when: '2026-09-30T01:02:03.456Z',
      big: '7n',
      nothing: null,
      callback: '[function]',
    });
    expect(line).not.toHaveProperty('skipped');
    expectValidLine(line);
  });

  it('redacts sensitive keys and secret-shaped values, strips newlines and caps length', () => {
    const { log, lines, parsed } = logger();
    log.info({
      authorization: 'Bearer abcdefghijklmnop',
      cookie: 'sid=1',
      apiToken: 'plain-looking',
      note: 'retry with Bearer abcdefghijklmnop please',
      multi: 'line one\nline two\r\nline three',
      big: 'x'.repeat(5000),
      loginForm: { password: 'hunter2' },
    });
    const [line] = parsed();
    expect(line.authorization).toBe('[REDACTED]');
    expect(line.cookie).toBe('[REDACTED]');
    expect(line.api_token).toBe('[REDACTED]');
    expect(line.note).toBe('retry with [REDACTED] please');
    expect(line.multi).toBe('line one line two  line three');
    expect((line.big as string).length).toBeLessThanOrEqual(1000 + '...[truncated]'.length);
    expect(line.login_form).toBe('{"password":"[REDACTED]"}');
    expect(lines[0]).not.toContain('hunter2');
    expectValidLine(line);
  });

  it('redacts objects passed after the message in a logger call, like the merge object', () => {
    const { log, lines, parsed } = logger();
    log.info('login', { password: 'hunter2', site: 'orzgk' });
    log.error(new Error('boom'), 'failed for', { headers: { cookie: 'sid=S3CR3T-COOKIE' } });
    log.warn('restored', new (class Session {
      cookie = 'sid=S3CR3T-COOKIE';
    })());
    // An Error after the message still reads as its message.
    log.warn('retry after', new Error('socket hang up'));
    expect(lines.join('\n')).not.toMatch(/hunter2|S3CR3T/);
    expect(parsed().map((line) => line.msg)).toEqual([
      'login {"password":"[REDACTED]","site":"orzgk"}',
      'failed for {"headers":{"cookie":"[REDACTED]"}}',
      'restored {"cookie":"[REDACTED]"}',
      'retry after socket hang up',
    ]);
  });

  it("redacts those objects with the logger's own options", () => {
    const { log, parsed } = logger({ redact: { sensitiveKeyPattern: /dpop/i } });
    log.info('proof', { dpopKey: 'jwk-secret', password: 'visible-under-a-custom-pattern' });
    expect(parsed()[0].msg).toBe('proof {"dpopKey":"[REDACTED]","password":"visible-under-a-custom-pattern"}');
  });

  it('renders err as {type, message} with the message redacted and on one line', () => {
    const { log, parsed } = logger();
    const err = new Error('upstream said Bearer abcdefghijklmnop\nand more');
    log.error({ err, event: 'rpc.in', call: 'a.v1.S/M', code: 'internal', duration_ms: 1, peer: 'unmeshed' }, 'failed');
    const [line] = parsed();
    expect(line.err).toEqual({ type: 'Error', message: 'upstream said [REDACTED] and more' });
    expectValidLine(line);
  });

  it('turns a non-Error err into a typed string message', () => {
    const { log, parsed } = logger();
    log.error({ err: 'just text' }, 'failed');
    log.error({ err: { code: 7 } }, 'failed');
    log.error({ err: 'retry with Bearer abcdefghijklmnop' }, 'failed');
    expect(parsed().map((line) => line.err)).toEqual([
      { type: 'string', message: 'just text' },
      { type: 'object', message: '{"code":7}' },
      { type: 'string', message: 'retry with [REDACTED]' },
    ]);
  });

  it('prints the reserved call, code, peer, job and event values by the same policy as any value', () => {
    const { log, lines, parsed } = logger();
    log.info({
      event: 'http.out',
      call: 'GET https://user:SECRET1@h.example/x?sig=SECRET2',
      code: 'https://h.example/x?sig=SECRET3',
      duration_ms: 1,
      peer: 'https://user:SECRET4@h.example',
      job: { token: 'SECRET5', name: 'nightly' },
    });
    log.info({
      event: 'app.x https://h.example/x?sig=SECRET6',
      call: 'lookup?token=SECRET9',
      peer: { password: 'SECRET7' },
      job: 'crawl https://h.example/?k=SECRET8',
    });
    const out = parsed();
    expect(out[0]).toMatchObject({
      call: 'GET https://h.example/x',
      code: 'https://h.example/x',
      peer: 'https://h.example',
      job: '{"token":"[REDACTED]","name":"nightly"}',
    });
    expect(out[1]).toMatchObject({
      event: 'app.x https://h.example/x',
      call: 'lookup',
      peer: '{"password":"[REDACTED]"}',
      job: 'crawl https://h.example/',
    });
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('keeps a bridged line an app.console line when its Error cannot be read', () => {
    const unreadable = new Error('x');
    Object.defineProperty(unreadable, 'message', {
      get() {
        throw new Error('getter threw');
      },
    });
    const { log, target, uninstall, parsed } = bridged();
    target.error('%s', unreadable);
    log.error({ err: unreadable }, 'field');
    // A printed value that starts with a bracket is the message, not a [TAG].
    target.log(Buffer.from('x'));
    uninstall();
    const out = parsed();
    expect(out.map((line) => [line.event, line.msg, line.tag])).toEqual([
      ['app.console', '[unserializable]', undefined],
      ['app.log', 'field', undefined],
      ['app.console', '[binary]', undefined],
    ]);
    expect(out[0].err).toEqual({ type: 'Error', message: '[unserializable]' });
    expect(out[1].err).toEqual({ type: 'Error', message: '[unserializable]' });
  });

  it('keeps the owned keys owned: callers cannot override time, level, service, version or ids', () => {
    const { log, parsed } = logger();
    log.info({
      time: 'yesterday', level: 'fatal', service: 'spoofed', version: '0', trace_id: 'f'.repeat(32),
      span_id: 'e'.repeat(16), msg: 'field msg',
    }, 'real msg');
    const [line] = parsed();
    expect(line.time).toMatch(ISO_MS);
    expect(line).toMatchObject({ level: 'info', service: 'ingest-server', version: '1.9.0', msg: 'real msg' });
    expect(line).not.toHaveProperty('trace_id');
    expect(line).not.toHaveProperty('span_id');
  });
});

describe('server log levels, identity and bindings', () => {
  it('filters below the configured level; silent emits nothing', () => {
    const quiet = logger({ level: 'warn' });
    quiet.log.trace('t');
    quiet.log.debug('d');
    quiet.log.info('i');
    quiet.log.warn('w');
    quiet.log.error('e');
    quiet.log.fatal('f');
    quiet.log.silent('s');
    expect(quiet.parsed().map((line) => line.level)).toEqual(['warn', 'error', 'fatal']);
    expect(quiet.log.level).toBe('warn');
    expect(quiet.log.isLevelEnabled('info')).toBe(false);
    expect(quiet.log.isLevelEnabled('error')).toBe(true);
    expect(quiet.log.isLevelEnabled('nonsense')).toBe(false);
    expect(quiet.log.isLevelEnabled('silent')).toBe(false);

    const silent = logger({ level: 'silent' });
    silent.log.fatal('nothing');
    expect(silent.lines).toEqual([]);
  });

  it('reads LOG_LEVEL from env and falls back to info on an unknown value', () => {
    const fromEnv = logger({ env: { LOG_LEVEL: 'debug' } });
    fromEnv.log.debug('shown');
    expect(fromEnv.lines).toHaveLength(1);

    const junk = logger({ env: { LOG_LEVEL: 'verbose' } });
    junk.log.debug('hidden');
    junk.log.info('shown');
    expect(junk.parsed().map((line) => line.msg)).toEqual(['shown']);
    expect(junk.log.level).toBe('info');
  });

  it('child loggers accumulate bindings and may change level', () => {
    const { log, parsed } = logger();
    const child = log.child({ site: 'orzgk' });
    const grandchild = child.child({ itemId: 7 }, { level: 'debug' });
    child.debug('hidden at info');
    grandchild.debug({ event: 'item.process', duration_ms: 3 }, 'shown');
    const lines = parsed();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ site: 'orzgk', item_id: 7, event: 'item.process', level: 'debug' });
    expect(grandchild.level).toBe('debug');
    expectValidLine(lines[0]);
  });

  it('a child given an empty or unknown level keeps its parent level, as pino does (Fastify 5 passes level "")', () => {
    const { log, parsed } = logger({ level: 'warn' });
    // The logger as Fastify's types hold it (pino's BaseLogger): child options whose level is any string.
    interface PinoChild {
      child(bindings: Record<string, unknown>, options?: { level?: string }): Logger;
    }
    const pinoLike: PinoChild = log;
    const request = pinoLike.child({ reqId: 'req-1' }, { level: '' });
    const unknown = pinoLike.child({}, { level: 'verbose' });
    const inherited = pinoLike.child({}, { level: 'constructor' });
    const spaced = pinoLike.child({}, { level: ' DEBUG ' });
    request.warn('incoming request');
    request.info('hidden');
    unknown.warn('unknown');
    inherited.warn('inherited');
    inherited.info('hidden');
    spaced.debug('spaced');
    expect([request.level, unknown.level, inherited.level, spaced.level]).toEqual(['warn', 'warn', 'warn', 'debug']);
    expect(parsed().map((line) => line.msg)).toEqual(['incoming request', 'unknown', 'inherited', 'spaced']);
    expect(parsed()[0].req_id).toBe('req-1');
  });

  it('reads a LOG_LEVEL that names an Object property (constructor) as unknown', () => {
    const junk = logger({ env: { LOG_LEVEL: 'constructor' } });
    junk.log.debug('hidden');
    junk.log.info('shown');
    expect(junk.parsed().map((line) => line.msg)).toEqual(['shown']);
    expect(junk.log.level).toBe('info');
  });

  it('stamps job from JOB_NAME (downward API) on every line', () => {
    const { log, parsed } = logger({ env: { JOB_NAME: 'ingest-crawler-29312345' } });
    log.info('tick');
    expect(parsed()[0].job).toBe('ingest-crawler-29312345');
  });

  it('resolves service and version: options, then OTEL/SERVICE env, then npm, then placeholders', () => {
    expect(resolveServiceIdentity({}, { service: 'a', version: '1' })).toEqual({ service: 'a', version: '1' });
    expect(resolveServiceIdentity({ OTEL_SERVICE_NAME: 'scraper', SERVICE_VERSION: '2.1.0' })).toEqual({
      service: 'scraper',
      version: '2.1.0',
    });
    expect(resolveServiceIdentity({ npm_package_version: '3.0.0' })).toEqual({
      service: 'unknown_service',
      version: '3.0.0',
    });
    expect(resolveServiceIdentity({ OTEL_SERVICE_NAME: '  ', SERVICE_VERSION: '' })).toEqual({
      service: 'unknown_service',
      version: 'unknown',
    });
  });

  it('writes to stdout, one newline-terminated line, when no sink is given', () => {
    const writes: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      createLogger({ ...BASE }).info('to stdout');
    } finally {
      spy.mockRestore();
    }
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(writes[0])).toMatchObject({ msg: 'to stdout' });
  });

  it('exposes the reserved key list in contract order', () => {
    expect(RESERVED_LOG_KEYS).toEqual([
      'time', 'level', 'service', 'version', 'event', 'msg', 'call', 'code', 'duration_ms',
      'peer', 'trace_id', 'span_id', 'job', 'err', 'queue_ms',
    ]);
  });

  it('converts keys to snake_case deterministically', () => {
    expect(toSnakeCase('itemId')).toBe('item_id');
    expect(toSnakeCase('HTTPStatus')).toBe('http_status');
    expect(toSnakeCase('already_snake')).toBe('already_snake');
    expect(toSnakeCase('with-dash.and space')).toBe('with_dash_and_space');
    expect(toSnakeCase('9lives')).toBe('f_9lives');
    expect(toSnakeCase('__')).toBe('field');
  });
});

describe('FC_LOG_FORMAT escape hatch', () => {
  it('text writes one human line carrying the same fields', () => {
    const { log, lines } = logger({ env: { FC_LOG_FORMAT: 'text' } });
    withRemoteSpan(() => log.warn({ event: 'job.end', code: 'error', duration_ms: 5, note: 'two words' }, 'pass failed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\S+Z WARN ingest-server job\.end pass failed code=error duration_ms=5 trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16} note="two words"$/,
    );
  });

  it('an explicit format option wins over env, and junk falls back to json', () => {
    const forced = logger({ env: { FC_LOG_FORMAT: 'text' }, format: 'json' });
    forced.log.info('x');
    expect(() => JSON.parse(forced.lines[0])).not.toThrow();

    const junk = logger({ env: { FC_LOG_FORMAT: 'yaml' } });
    junk.log.info('x');
    expect(() => JSON.parse(junk.lines[0])).not.toThrow();
  });

  it('text renders err and objects without breaking the line', () => {
    const { log, lines } = logger({ format: 'text' });
    log.error({ err: new Error('bad\nthing'), count: 2 }, 'oops');
    expect(lines[0]).toMatch(/ ERROR ingest-server app\.log oops err="Error: bad thing" count=2$/);
  });

  it('text quotes a value holding = or a double quote, so key=value stays parseable', () => {
    const { log, lines } = logger({ format: 'text' });
    log.info({ pair: 'a=b', quote: 'say"hi' }, 'm');
    expect(lines[0]).toMatch(/ m pair="a=b" quote="say\\"hi"$/);
  });
});

describe('every event kind validates against the published schema', () => {
  const kinds: Array<[string, Record<string, unknown>]> = [
    ['rpc.in', { call: 'ingest.v1.SpineIngest/Ingest', code: 'ok', duration_ms: 1, peer: 'unmeshed' }],
    ['rpc.out', { call: 'ingest.v1.SpineIngest/Ingest', code: 'unavailable', duration_ms: 1, peer: 'ingest-server.fc.svc:50061' }],
    ['http.in', { call: 'POST /ingest/scrape', code: '202', duration_ms: 1, peer: 'unmeshed' }],
    ['http.out', { call: 'GET /lookup', code: '200', duration_ms: 1, peer: 'scraper.fc.svc:3050' }],
    ['job.start', {}],
    ['job.end', { code: 'ok', duration_ms: 671000, stores: 27 }],
    ['item.enqueue', { site: 'orzgk' }],
    ['item.process', { duration_ms: 12, queue_ms: 30 }],
    ['ingest.reject', { code: 'invalid_argument', reason: 'no source' }],
    ['decision', { allowed: true }],
    ['app.console', { tag: 'CAPTURE' }],
    ['item.coalesced', { site: 'orzgk', winner_trace_id: 'a'.repeat(32) }],
    ['app.enrichment', { site: 'orzgk' }],
    ['app.scrape_queue.depth', { depth: 4 }],
  ];

  it.each(kinds)('%s', (event, fields) => {
    const { log, parsed } = logger();
    withRemoteSpan(() => log.info({ event, ...fields }, 'm'));
    expectValidLine(parsed()[0]);
  });
});

describe('console bridge', () => {
  function fakeConsole() {
    const calls: string[] = [];
    const make = (name: string) => (...args: unknown[]) => {
      calls.push(`${name}:${args.join(' ')}`);
    };
    return {
      calls,
      target: { log: make('log'), info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') },
    };
  }

  it('turns each console call into one app.console line at the mapped level', () => {
    const { log, parsed } = logger({ level: 'debug' });
    const { target, calls } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.log('a');
    target.info('b');
    target.warn('c');
    target.error('d');
    target.debug('e');
    uninstall();
    expect(calls).toEqual([]);
    const lines = parsed();
    expect(lines.map((line) => [line.event, line.level, line.msg])).toEqual([
      ['app.console', 'info', 'a'],
      ['app.console', 'info', 'b'],
      ['app.console', 'warn', 'c'],
      ['app.console', 'error', 'd'],
      ['app.console', 'debug', 'e'],
    ]);
    lines.forEach(expectValidLine);
  });

  it('parses a leading [TAG] into tag, multi-word tags included', () => {
    const { log, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.log('[CAPTURE] stored %d bytes', 42);
    target.log('[failures:retry]', 'sweep done');
    // Most of the scraper's tags hold a space.
    target.log('[BROWSER POOL] Launching browser');
    target.log('[SCRAPE QUEUE]  Enqueued item');
    target.log('[SESSION MANAGER]', 'Initialized');
    target.log('[SCRAPER API ] trailing space trimmed');
    target.log(`[${'T'.repeat(64)}] longest tag`);
    target.log('no tag [HERE]');
    target.log(`[${'T'.repeat(65)}] too long for a tag`);
    target.log('[ ] blank');
    target.log('["a", "b"]');
    // A tag starts with a letter and holds no bracket or line break.
    target.log('[0] item');
    target.log('[A[B] nested bracket');
    target.log('[A\nB] line break');
    uninstall();
    expect(parsed().map((line) => [line.tag, line.msg])).toEqual([
      ['CAPTURE', 'stored 42 bytes'],
      ['failures:retry', 'sweep done'],
      ['BROWSER POOL', 'Launching browser'],
      ['SCRAPE QUEUE', 'Enqueued item'],
      ['SESSION MANAGER', 'Initialized'],
      ['SCRAPER API', 'trailing space trimmed'],
      ['T'.repeat(64), 'longest tag'],
      [undefined, 'no tag [HERE]'],
      [undefined, `[${'T'.repeat(65)}] too long for a tag`],
      [undefined, '[ ] blank'],
      [undefined, '["a","b"]'],
      [undefined, '[0] item'],
      [undefined, '[A[B] nested bracket'],
      [undefined, '[A B] line break'],
    ]);
  });

  it("drops the legacy logger's leading [ISO timestamp] (the line has time) and reads the tag after it", () => {
    const { log, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.log('[2026-09-29T12:00:00.000Z] [INFO] legacy scraper line');
    target.warn('[2026-09-29T12:00:00Z] untagged legacy line');
    target.log('[2026-09-29T12:00:00.000+02:00] [INFO] offset timestamp');
    target.log('[2026-09-29T12:00:00-0500] compact offset');
    // Only a LEADING timestamp is dropped.
    target.log('retry at [2026-09-29T12:00:00Z] done');
    uninstall();
    expect(parsed().map((line) => [line.tag, line.msg])).toEqual([
      ['INFO', 'legacy scraper line'],
      [undefined, 'untagged legacy line'],
      ['INFO', 'offset timestamp'],
      [undefined, 'compact offset'],
      [undefined, 'retry at [2026-09-29T12:00:00Z] done'],
    ]);
  });

  it('redacts sensitive keys in object and printf arguments, as for logger fields', () => {
    const { log, lines, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.log({ cookie: 'sid=S3CR3T-COOKIE', authorization: 'Basic dXNlcjpodW50ZXIy', password: 'hunter2', site: 'orzgk' });
    target.log('[SESSION MANAGER] restored', { headers: { cookie: 'sid=S3CR3T-COOKIE' } }, ['x', { apiKey: 'k-123' }]);
    target.log('%o', { password: 'hunter2' });
    target.log('form %j', { password: 'hunter2' });
    target.log('login %s', { authorization: 'Basic dXNlcjpodW50ZXIy' });
    target.log(JSON.stringify({ store: 'orzgk', session: { cookie: 'sid=S3CR3T-COOKIE' } }, null, 2));
    target.log('fetching %s', new URL('https://img.store-cdn.example/a.jpg'));
    target.log(Object.assign(Object.create(null) as object, { token: 't-456' }));
    target.log({ a: { b: { c: { d: { e: 1 } } } } });
    target.log('nothing', null, undefined, 3);
    target.log({ site: 'orzgk', onDone: () => undefined });
    uninstall();
    expect(lines.join('\n')).not.toMatch(/S3CR3T|hunter2|dXNlcjpodW50ZXIy|k-123|t-456/);
    expect(parsed().map((line) => line.msg)).toEqual([
      '{"cookie":"[REDACTED]","authorization":"[REDACTED]","password":"[REDACTED]","site":"orzgk"}',
      'restored {"headers":{"cookie":"[REDACTED]"}} ["x",{"apiKey":"[REDACTED]"}]',
      "{ password: '[REDACTED]' }",
      'form {"password":"[REDACTED]"}',
      "login { authorization: '[REDACTED]' }",
      '{"store":"orzgk","session":{"cookie":"[REDACTED]"}}',
      // A URL prints as its string.
      'fetching https://img.store-cdn.example/a.jpg',
      '{"token":"[REDACTED]"}',
      // Walked four levels deep, like a logger field.
      '{"a":{"b":{"c":{"d":"[truncated:max-depth]"}}}}',
      'nothing null undefined 3',
      // A plain object is walked as is: a function shows, as in a field.
      '{"site":"orzgk","onDone":"[function]"}',
    ]);
  });

  it('redacts class instances and Errors in every argument position, printf included, as logger fields are', () => {
    class Session {
      user = 'ross';
      cookie = 'sid=CLASS-COOKIE-1';
      authorization = 'Basic Q0xBU1MtQVVUSA==';
    }
    class StoreConfig {
      store = 'orzgk';
      apiKey = 'CLASS-APIKEY-2';
    }
    const axiosError = new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', {
      url: 'https://store.example/a',
      headers: new AxiosHeaders({ Cookie: 'cf_clearance=AXERR-COOKIE' }),
    });
    const plainError = Object.assign(new Error('boom'), { request: { headers: { cookie: 'sid=PLAINERR-COOKIE' } } });
    const { log, lines, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.log('[SESSION] restored', new Session());
    target.log(new StoreConfig());
    target.log('%o', new Session());
    target.log('login %s', new Session());
    target.log('cfg %j', new StoreConfig());
    target.log('[HTTP] request headers', new AxiosHeaders({ Cookie: 'cf_clearance=AXIOS-COOKIE-3', Authorization: 'Basic QVhJT1M=' }));
    target.log('headers %o', new Headers({ cookie: 'sid=FETCH-HEADERS-4' }));
    target.log('jar %o', new Map([['cookie', 'sid=MAP-COOKIE-5']]));
    target.error('[SCRAPER API] failed %o', axiosError);
    target.error('failed %O', plainError);
    target.error('failed %j', plainError);
    target.log('at %s', new Date('2026-09-29T12:00:00.000Z'));
    target.log('open', new URL('https://img.store-cdn.example/b.jpg'));
    uninstall();

    expect(lines.join('\n')).not.toMatch(/CLASS-|AXIOS-|AXERR-|PLAINERR-|FETCH-HEADERS|MAP-COOKIE|Q0xBU1Mt|QVhJT1M/);
    const msgs = parsed().map((line) => line.msg as string);
    expect(msgs.slice(0, 8)).toEqual([
      'restored {"user":"ross","cookie":"[REDACTED]","authorization":"[REDACTED]"}',
      '{"store":"orzgk","apiKey":"[REDACTED]"}',
      "{ user: 'ross', cookie: '[REDACTED]', authorization: '[REDACTED]' }",
      "login { user: 'ross', cookie: '[REDACTED]', authorization: '[REDACTED]' }",
      'cfg {"store":"orzgk","apiKey":"[REDACTED]"}',
      'request headers {"Cookie":"[REDACTED]","Authorization":"[REDACTED]"}',
      // fetch Headers hides itself from util.inspect: its class name. A Map serialises to {}.
      "headers '[Headers]'",
      'jar {}',
    ]);
    // An Error is {name, message, stack} with secret-shaped values masked, never its own properties.
    expect(msgs[8]).toMatch(/^failed \{ name: 'AxiosError', message: 'Request failed with status code 403', stack: 'AxiosError: /);
    expect(msgs[9]).toMatch(/^failed \{ name: 'Error', message: 'boom', stack: 'Error: boom/);
    expect(msgs[10]).toMatch(/^failed \{"name":"Error","message":"boom","stack":"Error: boom/);
    // A Date or URL becomes its string.
    expect(msgs.slice(11)).toEqual(['at 2026-09-29T12:00:00.000Z', 'open https://img.store-cdn.example/b.jpg']);
  });

  it('marks a cycle, and prints an instance whose toJSON gives nothing as its class name', () => {
    class Circular {
      name = 'pool';
      cookie = 'sid=CIRCULAR-COOKIE';
      self: unknown = this;
    }
    class Opaque {
      cookie = 'sid=OPAQUE-COOKIE';
      toJSON(): undefined {
        return undefined;
      }
    }
    const { log, lines, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.log('pool', new Circular());
    target.log('%o', new Circular());
    target.log('opaque', new Opaque());
    uninstall();
    expect(lines.join('\n')).not.toMatch(/CIRCULAR-COOKIE|OPAQUE-COOKIE/);
    expect(parsed().map((line) => line.msg)).toEqual([
      'pool {"name":"pool","cookie":"[REDACTED]","self":"[circular]"}',
      "{ name: 'pool', cookie: '[REDACTED]', self: '[circular]' }",
      'opaque [Opaque]',
    ]);
  });

  it('redacts with the default options when bridging a logger fc-shared did not create', () => {
    const received: unknown[][] = [];
    const record = (...args: unknown[]) => {
      received.push(args);
    };
    const foreign: Logger = {
      level: 'info', trace: record, debug: record, info: record, warn: record, error: record, fatal: record,
      silent: record, child: () => foreign, isLevelEnabled: () => true,
    };
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(foreign, target);
    target.log('login', { password: 'hunter2' });
    uninstall();
    expect(received).toEqual([[{ event: 'app.console' }, 'login {"password":"[REDACTED]"}']]);
  });

  it("uses the logger's own redaction options for bridged objects, through a child too", () => {
    const { log, parsed } = logger({ redact: { sensitiveKeyPattern: /dpop/i } });
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log.child({ component: 'auth' }), target);
    target.log('proof', { dpopKey: 'jwk-secret', password: 'visible-under-a-custom-pattern' });
    target.log('proof %j', { dpopKey: 'jwk-printf', password: 'visible-printf' });
    target.log(JSON.stringify({ dpopKey: 'jwk-json', password: 'visible-json' }));
    target.log('proof', new (class Jwk {
      dpopKey = 'jwk-class';
      password = 'visible-class';
    })());
    uninstall();
    expect(parsed().map((line) => line.msg)).toEqual([
      'proof {"dpopKey":"[REDACTED]","password":"visible-under-a-custom-pattern"}',
      'proof {"dpopKey":"[REDACTED]","password":"visible-printf"}',
      '{"dpopKey":"[REDACTED]","password":"visible-json"}',
      'proof {"dpopKey":"[REDACTED]","password":"visible-class"}',
    ]);
  });

  it('collapses a multi-line JSON string argument to one compact line', () => {
    const { log, lines, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.log('[SUMMARY]', JSON.stringify({ store: 'orzgk', enqueued: 12, ids: [1, 2] }, null, 2));
    target.log('{ not json\n  at all');
    uninstall();
    expect(lines.every((line) => !line.includes('\n'))).toBe(true);
    expect(parsed().map((line) => line.msg)).toEqual([
      '{"store":"orzgk","enqueued":12,"ids":[1,2]}',
      '{ not json   at all',
    ]);
  });

  it('prints objects on one line and records an Error argument as err', () => {
    const { log, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    target.error('scrape failed for', { url: 'https://x.example/a', attempt: 2 }, new Error('socket hang up'));
    uninstall();
    const [line] = parsed();
    expect(line.msg).toBe('scrape failed for {"url":"https://x.example/a","attempt":2} Error: socket hang up');
    expect(line.err).toEqual({ type: 'Error', message: 'socket hang up' });
    expectValidLine(line);
  });

  it('restores the original methods and does not recurse when the sink writes to console', () => {
    const { target, calls } = fakeConsole();
    const originalLog = target.log;
    const lines: string[] = [];
    const recursive = createLogger({
      ...BASE,
      sink: (line) => {
        lines.push(line);
        target.log('sink echo');
      },
    });
    const uninstall = installConsoleBridge(recursive, target);
    target.log('once');
    uninstall();
    expect(target.log).toBe(originalLog);
    expect(lines).toHaveLength(1);
    expect(calls).toEqual(['log:sink echo']);
  });

  it('bridges the real console when no target is given', () => {
    const { log, parsed } = logger();
    const realLog = console.log;
    const uninstall = installConsoleBridge(log);
    try {
      console.log('[REAL] via global console');
    } finally {
      uninstall();
    }
    expect(console.log).toBe(realLog);
    expect(parsed()[0]).toMatchObject({ tag: 'REAL', msg: 'via global console' });
  });

  it('carries the active trace ids like any other line', () => {
    const { log, parsed } = logger();
    const { target } = fakeConsole();
    const uninstall = installConsoleBridge(log, target);
    context.with(ROOT_CONTEXT, () => withRemoteSpan(() => target.log('inside')));
    uninstall();
    expect(parsed()[0]).toMatchObject({ trace_id: TRACE_ID, span_id: SPAN_ID });
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});

/** A console stand-in whose methods record nothing: every call goes to the bridge. */
function bridged(extra: Record<string, unknown> = {}) {
  const capture = captureSink();
  const log = createLogger({ ...BASE, sink: capture.sink, ...extra });
  const noop = (..._args: unknown[]): void => undefined;
  const target = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
  const uninstall = installConsoleBridge(log, target);
  return { log, target, uninstall, ...capture, msgs: () => capture.parsed().map((line) => line.msg) };
}

describe('URLs in log output lose their query, fragment and userinfo (plan-v2 propagation_and_redaction)', () => {
  it('prints a URL field holding ?sig=SECRET without the query (plan-v2 U1 acceptance)', () => {
    const { log, lines, parsed } = logger();
    log.info({ url: 'https://x.example/a/b?sig=SECRET#f' }, 'fetch');
    const [line] = parsed();
    expect(line.url).toBe('https://x.example/a/b');
    expect(lines[0]).not.toMatch(/\?|SECRET|#f/);
    expectValidLine(line);
  });

  it.each([
    ['a signed image URL', 'https://img.store-cdn.example/a.jpg?X-Amz-Signature=SECRET&exp=1', 'https://img.store-cdn.example/a.jpg'],
    ['userinfo', 'https://user:SECRET@h.example:8443/x', 'https://h.example:8443/x'],
    ['userinfo holding an @', 'https://u:SEC@RET@h.example/x', 'https://h.example/x'],
    ['a connection string', 'postgresql://app:SECRET@pg-spine-rw.data.svc:5432/spine?sslmode=require', 'postgresql://pg-spine-rw.data.svc:5432/spine'],
    ['an upper-case scheme', 'HTTPS://X.EXAMPLE/A?SIG=SECRET', 'HTTPS://X.EXAMPLE/A'],
    ['a fragment', 'https://x.example/p#SECRET', 'https://x.example/p'],
    ['a host with no path', 'https://x.example?k=SECRET', 'https://x.example'],
    ['an @ in the path, not userinfo', 'https://x.example/u/@ross?k=SECRET', 'https://x.example/u/@ross'],
    ['a path with a query', '/login?token=SECRET', '/login'],
    ['a path with a fragment', '/p#SECRET', '/p'],
    ['a padded path', '  /login?token=SECRET ', '/login'],
    ['a protocol-relative URL', '//cdn.example/i.jpg?sig=SECRET', '//cdn.example/i.jpg'],
    ['a URL inside text', 'retry https://x.example/a?sig=SECRET in 5s', 'retry https://x.example/a in 5s'],
    ['a URL glued to a word', 'src=https://x.example/a?sig=SECRET', 'src=https://x.example/a'],
    ['two URLs', 'from https://a.example/?k=SECRET to http://b.example/c#SECRET', 'from https://a.example/ to http://b.example/c'],
    ['a quoted URL', "open 'https://x.example/a?sig=SECRET' now", "open 'https://x.example/a' now"],
    // A query runs to the next space, never to a quote: encodeURIComponent leaves an apostrophe raw.
    ['a query holding an apostrophe (the plan-v2 U1 acceptance URL)', `https://x.example/a/b?q=${encodeURIComponent("it's")}&sig=SECRET#f`, 'https://x.example/a/b'],
    [
      "the scraper initiator's lookup URL for a title with an apostrophe",
      `http://scraper.fc.svc:3050/lookup?q=${encodeURIComponent("JoJo's Bizarre Adventure")}&mode=screen&token=SECRET`,
      'http://scraper.fc.svc:3050/lookup',
    ],
    ['a query holding a double quote', 'https://store.example/search?q=say"hi"&sig=SECRET', 'https://store.example/search'],
    ['a query holding < and >', 'https://store.example/search?q=<b>&sig=SECRET', 'https://store.example/search'],
    ['a query holding a backtick', 'https://store.example/search?q=a`b&sig=SECRET', 'https://store.example/search'],
    ['a query holding an apostrophe inside text', "retry https://x.example/a?q=it's&sig=SECRET in 5s", 'retry https://x.example/a in 5s'],
    ['an apostrophe in the path inside text', "see https://x.example/it's/a?sig=SECRET now", "see https://x.example/it's/a now"],
    ['a double-quoted URL, keeping the closing quote', 'open "https://x.example/a?q=say"hi"&sig=SECRET" now', 'open "https://x.example/a" now'],
    ['a URL in brackets, keeping the closing ones', 'see (https://x.example/a?sig=SECRET).', 'see (https://x.example/a).'],
    ['a URL in JSON inside text', 'body {"url":"https://x.example/a?sig=SECRET"} end', 'body {"url":"https://x.example/a"} end'],
    // A whole value with no space that is a host or path with a query, with no scheme.
    ['a host and path with no scheme', 'img.store.example/a.jpg?X-Amz-Signature=SECRET', 'img.store.example/a.jpg'],
    ['a relative path with no leading slash', 'api/v1/items?sig=SECRET', 'api/v1/items'],
    ['a host and port with no scheme', 'localhost:3000/a?sig=SECRET', 'localhost:3000/a'],
    ['a scheme with no slashes', 'mailto:ross@x.example?subject=SECRET', 'mailto:ross@x.example'],
    ['a scheme with one slash', 'https:/x.example/a?sig=SECRET', 'https:/x.example/a'],
    ['backslashes for slashes', 'https:\\\\x.example\\a?sig=SECRET', 'https:\\\\x.example\\a'],
    ['userinfo holding an apostrophe', "https://u:pa'ss@h.example/x", 'https://h.example/x'],
    ['a host with no path and no scheme', 'cdn.example?sig=SECRET', 'cdn.example'],
    ['an upper-case host with no path and no scheme', 'CDN.Example?sig=SECRET', 'CDN.Example'],
    ['an IP address and port with no scheme', '10.0.0.5:8080?sig=SECRET', '10.0.0.5:8080'],
    ['a path whose query holds a space', 'api/v1/items?q=hello world&sig=SECRET', 'api/v1/items'],
    ['a URL whose query runs past a line break', 'https://h.example/a?x=1\nsig=SECRET', 'https://h.example/a'],
    ['a scheme ending in digits, inside text', 'see svc12345://h.example/a?sig=SECRET now', 'see svc12345://h.example/a now'],
    ['a bare query string', '?access_token=SECRET&state=1', ''],
    ['a bare fragment of key=value pairs', '#access_token=SECRET', ''],
    ['a request line', 'POST /login?sig=SECRET HTTP/1.1', 'POST /login HTTP/1.1'],
    ['a request line inside text', 'got GET /items?sig=SECRET 200 in 5 ms', 'got GET /items 200 in 5 ms'],
    ['a request target in brackets', 'retry (PUT /items/1#SECRET).', 'retry (PUT /items/1).'],
    ['an upper-case scheme inside text', 'see HTTPS://X.EXAMPLE/A?SIG=SECRET now', 'see HTTPS://X.EXAMPLE/A now'],
    [
      'URLs closed by brackets and punctuation',
      'see <https://a.example/x?s=SECRET>, [https://b.example/y?s=SECRET]; `https://c.example/z?s=SECRET`: https://d.example/w?s=SECRET!',
      'see <https://a.example/x>, [https://b.example/y]; `https://c.example/z`: https://d.example/w!',
    ],
    ['a Windows-style path', 'dir\\sub\\file.txt?sig=SECRET', 'dir\\sub\\file.txt'],
    ['a padded bare query string', '  ?token=SECRET ', ''],
    // Cut at the FIRST ? or #, whichever comes first. (Keys that are not sensitive, so the form rule cannot mask them.)
    ['a path with a query, then a fragment', '/login?q=SECRET#frag', '/login'],
    ['a path with a fragment, then a query', '/cb#state=SECRET?x=1', '/cb'],
    ['a request target with a fragment, then a query', 'GET /x#SECRET?y HTTP/1.1', 'GET /x HTTP/1.1'],
    // A first token of any shape, when key=value pairs follow its ? or #.
    ['a single-label host with a query', 'scraper?q=SECRET', 'scraper'],
    ['an IPv6 host and port with a query', '[::1]:8080?sig=SECRET', '[::1]:8080'],
    ['an internationalised host with a query', 'bücher.example?sig=SECRET', 'bücher.example'],
    ['a single-label host with key=value pairs in a fragment', 'scraper#state=SECRET', 'scraper'],
    ['a protocol-relative URL inside text', 'see //cdn.example/a?sig=SECRET now', 'see //cdn.example/a now'],
    // Fastify's default not-found message: the method and the URL joined by a colon.
    ['a method and target joined by a colon', 'Route GET:/nothere?sig=SECRET not found', 'Route GET:/nothere not found'],
    ['a colon-joined target with a fragment, then a query', 'Route GET:/x#SECRET?y not found', 'Route GET:/x not found'],
    ...['HEAD', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'].map((method) => [
      `a ${method} request line`,
      `${method} /x?sig=SECRET HTTP/1.1`,
      `${method} /x HTTP/1.1`,
    ]),
  ])('strips %s', (_label, value, expected) => {
    const { log, lines, parsed } = logger();
    log.info({ note: value });
    expect(parsed()[0].note).toBe(expected);
    expect(lines[0]).not.toContain('SECRET');
  });

  it.each([
    ['a URL with nothing to strip keeps its exact text', 'https://X.example'],
    ['a file URL', 'file:///app/dist/server.mjs:10:5'],
    ['a question in text', 'why? because'],
    ['a word with a question mark', 'a?b'],
    ['a path followed by text', '/a b?c'],
    ['a path inside text', 'see /docs?page=2 for more'],
    ['a padded number (JSON, but not an object or array)', ' 42 '],
    ['a word ending in a question mark', 'ready?'],
    ['a numbered item', 'item#3'],
    ['a URL at the end of a sentence', 'see https://x.example/a.'],
    ['a hashtag in text', '#3 in the queue'],
    ['a label and a question', 'Q: why?'],
    ['an HTTP method in lower case', 'get /items?page=2 later'],
    ['a request line with no query', 'GET /items HTTP/1.1'],
    ['a header name inside prose', 'the cookie: header was missing'],
    ['an abbreviation with a question mark', 'e.g.?'],
    ['a bracketed question', '(Q:why?)'],
    ['a numbered note holding an =', '#1 retry with x=2'],
    ['a method name inside a word', 'BUDGET /items?page=2 later'],
    ['a word that starts with a method name', 'POSTER? no'],
    ['a question, then key=value text', 'why? x=1'],
    ['a question, then a query further on', 'ok? see a?b=1'],
    ['a word and a question mark with no key=value after it', 'scraper?ok'],
    ['a comment marker inside text', 'see a // b?c'],
    ['a method name and a colon in prose', 'GET: why?'],
  ])('leaves %s alone', (_label, value) => {
    const { log, parsed } = logger();
    log.info({ note: value });
    expect(parsed()[0].note).toBe(value);
  });

  it.each([
    // axios's config.url, relative to a baseURL (url 'login?...' with config.baseURL set).
    ['url', 'login?access_token=SECRET', 'login'],
    ['url', 'https://store.example/search?q=hello world&sig=SECRET', 'https://store.example/search'],
    ['url', "https://x.example/a/b?q=it's&sig=SECRET#f", 'https://x.example/a/b'],
    ['url', 'https://u:SECRET@x.example/a', 'https://x.example/a'],
    ['url', 'https://x.example/a?q=(SECRET)', 'https://x.example/a'],
    ['imageUrl', 'img.example/a.jpg?sig=SECRET', 'img.example/a.jpg'],
    ['uri', 'items?page=2&sig=SECRET', 'items'],
    ['href', 'next #SECRET', 'next'],
    ['redirectUri', 'https://x.example/cb?code=SECRET', 'https://x.example/cb'],
    ['link', 'why? SECRET', 'why'],
    ['path', 'items?sig=SECRET', 'items'],
    ['target', 'orders?sig=SECRET', 'orders'],
    ['endpoint', 'orders#SECRET', 'orders'],
    ['location', 'next?sig=SECRET', 'next'],
    ['referer', 'page?sig=SECRET', 'page'],
    ['redirect', 'home?sig=SECRET', 'home'],
    ...['uris', 'hrefs', 'paths', 'endpoints', 'referrer', 'redirects'].map((key) => [key, 'a?SECRET', 'a']),
    // A key of several words, one of them URL-named; the value does not look like a URL.
    ['nextPageUrl', 'page 2?cursor=SECRET', 'page 2'],
  ])('cuts a %s field at its first ? or # (%s)', (key, value, expected) => {
    const { log, lines, parsed } = logger();
    log.info({ [key]: value });
    expect(parsed()[0][toSnakeCase(key)]).toBe(expected);
    expect(lines[0]).not.toContain('SECRET');
  });

  it('cuts URL-named keys at any depth, the arrays under them and the JSON strings holding them', () => {
    const { log, lines, parsed } = logger();
    log.info({
      config: { baseURL: 'http://h.example/api/', url: 'login?access_token=SECRET1', method: 'post' },
      page: { links: ['next page?cursor=SECRET2', ['prev#SECRET3']], title: 'why? because' },
      body: '{"redirect_uri":"cb?code=SECRET4"}',
      images: [{ src: 'x', href: "a.jpg?q=it's&sig=SECRET5" }],
      urls: ['a b?SECRET6'],
      hrefs: '["next?cursor=SECRET7"]',
      paging: { nextPageUrl: 'page 2?cursor=SECRET8' },
    });
    const [line] = parsed();
    expect(line.config).toBe('{"baseURL":"http://h.example/api/","url":"login","method":"post"}');
    expect(line.page).toBe('{"links":["next page",["prev"]],"title":"why? because"}');
    expect(line.body).toBe('{"redirect_uri":"cb"}');
    expect(line.images).toBe('[{"src":"x","href":"a.jpg"}]');
    expect(line.urls).toBe('["a b"]');
    expect(line.hrefs).toBe('["next"]');
    expect(line.paging).toBe('{"nextPageUrl":"page 2"}');
    expect(lines[0]).not.toContain('SECRET');
  });

  it('cuts URL-named keys in bridged and printf arguments and in the text format', () => {
    const { target, uninstall, lines, msgs } = bridged();
    target.log('%o', { url: 'login?access_token=SECRET1' });
    target.log('retry', { config: { url: "a b?q=it's&sig=SECRET2" } });
    uninstall();
    expect(msgs()).toEqual(["{ url: 'login' }", 'retry {"config":{"url":"a b"}}']);
    const text = logger({ format: 'text' });
    text.log.info({ url: "https://h.example/a?q=it's&sig=SECRET3" }, 'm');
    expect(text.lines[0]).toMatch(/ m url=https:\/\/h\.example\/a$/);
    expect([...lines, ...text.lines].join('\n')).not.toContain('SECRET');
  });

  it('strips URLs used as object keys, nested and at the top level', () => {
    const { log, lines, parsed } = logger();
    log.info({
      // Query values with no sensitive word, so the key's own words do not mask the value.
      statuses: { 'https://cdn.example/a.jpg?X-Amz-Signature=hunter1': 403, plain: 200 },
      'https://cdn.example/b.jpg?sig=hunter2': 404,
    });
    const [line] = parsed();
    expect(line.statuses).toBe('{"https://cdn.example/a.jpg":403,"plain":200}');
    expect(line.https_cdn_example_b_jpg).toBe(404);
    expect(lines[0]).not.toMatch(/hunter/);
  });

  it('masks the value of a key that names a secret before its query is cut, nested and at the top level', () => {
    const { log, lines, parsed } = logger();
    // 'api key' names a secret only once printed (api_key): that decides too.
    log.info({ cache: { '/login?password': 'hunter1', '/a?page': 2 }, '/login?token': 'hunter2', 'api key': 'hunter3' });
    const [line] = parsed();
    expect(line.cache).toBe('{"/login":"[REDACTED]","/a":2}');
    expect(line).toMatchObject({ login: '[REDACTED]', api_key: '[REDACTED]' });
    expect(lines[0]).not.toContain('hunter');
  });

  it("prints err.type, an Error's name, as any value is", () => {
    const { log, lines, parsed } = logger();
    const named = new Error('m');
    named.name = 'https://h.example/a?sig=hunter3';
    log.error({ err: named });
    expect(parsed()[0].err).toEqual({ type: 'https://h.example/a', message: 'm' });
    expect(lines[0]).not.toContain('hunter3');
  });

  it('prints nested object keys through the secret-shape and header-line rules', () => {
    const { log, lines, parsed } = logger();
    log.info({ deep: { 'Bearer abcdefghijklmnop': 1, 'Cookie: sid=hunter7': 2 } });
    // Both keys name a secret (a bearer token, a cookie), so their values are masked too.
    expect(parsed()[0].deep).toBe('{"[REDACTED]":"[REDACTED]","Cookie: [REDACTED]":"[REDACTED]"}');
    expect(lines[0]).not.toMatch(/abcdefghijklmnop|hunter7/);
  });

  it('prints a framework wrapper around a node HTTP message (Fastify Request, Reply) as that message', async () => {
    const { log, lines, parsed } = logger();
    const server = http.createServer((req, res) => {
      // Fastify's Request and Reply keep node's message in raw, the parsed query beside it.
      const request = { id: 'req-1', params: { id: '1' }, raw: req, query: { sig: 'QSIG-SECRET' }, log };
      const reply = { raw: res, request, log };
      log.info({ req: request }, 'incoming request');
      log.info({ res: reply, responseTime: 1.5 }, 'request completed');
      // First, a wrapper is a message part (as a stream is), not a merge object.
      log.info(request, 'incoming');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await new Promise<http.IncomingMessage>((resolve) => {
      http.get(`http://127.0.0.1:${port}/items/1?sig=URL-SECRET`, resolve);
    });
    response.resume();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(lines.join('\n')).not.toMatch(/[A-Z]+-SECRET/);
    const [incoming, completed, first] = parsed();
    expect(incoming.req).toBe('{"method":"GET","url":"/items/1"}');
    expect(completed).toMatchObject({ res: '{"statusCode":200}', response_time: 1.5 });
    expect(first.msg).toBe('{"method":"GET","url":"/items/1"} incoming');
    expect(first).not.toHaveProperty('query');
  });

  it('prints a query holding an apostrophe without it in msg, err.message, bridged and text output', () => {
    const url = `https://x.example/a/b?q=${encodeURIComponent("it's")}&sig=SECRET#f`;
    const { log, target, uninstall, lines, msgs } = bridged();
    log.info(`fetch ${url} failed`);
    log.error(new Error(`GET ${url} failed`));
    target.log(`retry ${url}`);
    target.log('retry %s', url);
    uninstall();
    expect(msgs()).toEqual([
      'fetch https://x.example/a/b failed',
      'GET https://x.example/a/b failed',
      'retry https://x.example/a/b',
      'retry https://x.example/a/b',
    ]);
    const text = logger({ format: 'text' });
    text.log.info({ link: url }, `open ${url}`);
    expect(text.lines[0]).toMatch(/ open https:\/\/x\.example\/a\/b link=https:\/\/x\.example\/a\/b$/);
    expect([...lines, ...text.lines].join('\n')).not.toMatch(/SECRET|#f|\?/);
  });

  it('masks the value of a sensitive header line and the query of a request line in a raw header block', () => {
    const { log, lines, parsed } = logger();
    log.info({
      head: 'POST /login?sig=SECRET1 HTTP/1.1\r\nHost: h.example\r\nX-Api-Key: SECRET2\r\nCookie: sid=SECRET3\r\nAuthorization: Basic U0VDUkVUNA==',
    });
    log.info('Proxy-Authorization:Basic U0VDUkVUNQ==');
    log.info({ note: 'Note: password rotation is due\nX-Request-Id: 42' });
    log.info({ lone: 'x\rCookie: sid=SECRET4', spaced: 'Set-Cookie : sid=SECRET5', odd: 'X_Token2: SECRET6' });
    const out = parsed();
    expect(out[0].head).toBe(
      'POST /login HTTP/1.1  Host: h.example  X-Api-Key: [REDACTED]  Cookie: [REDACTED]  Authorization: [REDACTED]',
    );
    expect(out[1].msg).toBe('Proxy-Authorization:[REDACTED]');
    expect(out[2].note).toBe('Note: password rotation is due X-Request-Id: 42');
    expect(out[3]).toMatchObject({ lone: 'x Cookie: [REDACTED]', spaced: 'Set-Cookie : [REDACTED]', odd: 'X_Token2: [REDACTED]' });
    expect(lines.join('\n')).not.toMatch(/SECRET|U0VDUkVU/);
  });

  it('masks the value after a sensitive name in a raw header list (rawHeaders), under any key', () => {
    const { log, lines, parsed } = logger();
    // The values hold no sensitive word themselves: only the name before each one decides.
    log.info({
      raw: ['Host', 'h.example', 'Set-Cookie', 'sid=hunter1', 'Authorization', 'Basic aHVudGVyMg=='],
      reversed: ['Cookie', 'sid=hunter3', 'Host', 'h.example'],
      numbered: [7, 'seven', 'X-Api-Key', 'hunter4'],
    });
    log.info({ odd: ['token', 'kept', 'x'], spaced: ['the token', 'kept'], empty: [] });
    const out = parsed();
    expect(out[0].raw).toBe('["Host","h.example","Set-Cookie","[REDACTED]","Authorization","[REDACTED]"]');
    expect(out[0].reversed).toBe('["Cookie","[REDACTED]","Host","h.example"]');
    expect(out[0].numbered).toBe('[7,"seven","X-Api-Key","[REDACTED]"]');
    // Not a header list: an odd length, or a name that is not a header name.
    expect(out[1]).toMatchObject({ odd: '["token","kept","x"]', spaced: '["the token","kept"]', empty: '[]' });
    expect(lines.join('\n')).not.toMatch(/hunter|aHVudGVy/);
  });

  it("masks header lines and header lists with the logger's own placeholder", () => {
    const { log, parsed } = logger({ redact: { placeholder: '<hidden>' } });
    log.info({ password: 'hunter1', head: 'Cookie: sid=hunter2', raw: ['Cookie', 'sid=hunter3'] });
    expect(parsed()[0]).toMatchObject({ password: '<hidden>', head: 'Cookie: <hidden>', raw: '["Cookie","<hidden>"]' });
  });

  it('prints a node HTTP request, response or socket as a short summary, never its raw headers', async () => {
    const { log, target, uninstall, lines, parsed } = bridged();
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        log.info({ req }, 'in');
        log.info(req, 'incoming');
        target.log(req);
        log.info({ raw: req.rawHeaders });
        log.info({ socket: req.socket, res });
        target.log(req.socket);
      }
      req.resume();
      req.on('end', () => {
        res.statusCode = 403;
        res.setHeader('Set-Cookie', 'sid=SETCOOKIE-SECRET');
        res.end('no');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    // A relative url under a baseURL (config.url keeps only 'login?...'); the axios README's error handling logs error.request.
    const err = (await axios
      .post('login?access_token=QUERY-SECRET', { password: 'BODYPW-SECRET' }, {
        baseURL: `http://127.0.0.1:${port}/api/`,
        headers: { Authorization: 'Basic BASICAUTH-SECRET', 'X-Api-Key': 'APIKEY-SECRET', Cookie: 'sid=REQCOOKIE-SECRET' },
      })
      .catch((error: unknown) => error)) as AxiosError;
    const response = await new Promise<http.IncomingMessage>((resolve) => {
      http.get(`http://127.0.0.1:${port}/ping?sig=PING-SECRET`, resolve);
    });
    response.resume();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(err).toBeInstanceOf(AxiosError);

    log.warn({ url: err.config?.url, request: err.request, req: err.response?.request });
    log.warn(err.response, 'failed');
    log.warn({ config: err.config });
    target.log(err.request);
    target.error('failed %O', err.response?.request);
    log.info({ response });
    uninstall();

    expect(lines).toHaveLength(12);
    expect(lines.join('\n')).not.toMatch(/[A-Z]+-SECRET/);
    const out = parsed();
    const incoming = '{"method":"POST","url":"/api/login"}';
    const outgoing = '{"method":"POST","host":"127.0.0.1","path":"/api/login"}';
    expect(out[0].req).toBe(incoming);
    expect(out[1].msg).toBe(`${incoming} incoming`);
    expect(out[2].msg).toBe(incoming);
    const raw = JSON.parse(out[3].raw as string) as string[];
    expect(raw[raw.indexOf('Authorization') + 1]).toBe('[REDACTED]');
    expect(raw[raw.indexOf('Cookie') + 1]).toBe('[REDACTED]');
    expect(raw[raw.indexOf('X-Api-Key') + 1]).toBe('[REDACTED]');
    expect(raw[raw.indexOf('Host') + 1]).toBe(`127.0.0.1:${port}`);
    expect(out[4]).toMatchObject({ socket: '[Socket]', res: '{"statusCode":200}' });
    expect(out[5]).toMatchObject({ msg: '[Socket]', event: 'app.console' });
    expect(out[5]).not.toHaveProperty('tag');
    expect(out[6]).toMatchObject({ url: 'login', request: outgoing, req: outgoing });
    expect(out[7]).toMatchObject({ status: 403, request: outgoing, msg: 'failed' });
    expect(out[8].config).toContain('"url":"login"');
    expect(out[9].msg).toBe(outgoing);
    expect(out[10].msg).toBe("failed { method: 'POST', host: '127.0.0.1', path: '/api/login' }");
    expect(out[11].response).toBe('{"statusCode":403}');
  });

  it('strips URLs inside object fields, arrays and URL instances', () => {
    const { log, lines, parsed } = logger();
    log.info({
      page: { src: 'https://img.example/a.jpg?sig=SECRET', thumbs: ['https://img.example/t.jpg?sig=SECRET'] },
      imageUrl: new URL('https://img.example/b.jpg?sig=SECRET'),
    });
    const [line] = parsed();
    expect(line.page).toBe('{"src":"https://img.example/a.jpg","thumbs":["https://img.example/t.jpg"]}');
    expect(line.image_url).toBe('https://img.example/b.jpg');
    expect(lines[0]).not.toContain('SECRET');
  });

  it('strips URLs in the message, its parts and err.message', () => {
    const { log, lines, parsed } = logger();
    log.info('fetching https://x.example/a?sig=SECRET1');
    log.info('open', new URL('https://x.example/b?sig=SECRET2'), 'https://x.example/c?sig=SECRET3');
    log.error(new Error('request to https://x.example/d?token=SECRET4 failed'));
    log.error({ err: '/e?token=SECRET5' }, 'failed');
    const out = parsed();
    expect(out.map((line) => line.msg)).toEqual([
      'fetching https://x.example/a',
      'open https://x.example/b https://x.example/c',
      'request to https://x.example/d failed',
      'failed',
    ]);
    expect(out[2].err).toEqual({ type: 'Error', message: 'request to https://x.example/d failed' });
    expect(out[3].err).toEqual({ type: 'string', message: '/e' });
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('strips URLs in every bridged argument, printf included', () => {
    const { target, uninstall, lines, msgs } = bridged();
    target.log('open', new URL('https://x.example/a?sig=SECRET1'));
    target.log('fetch %s', 'https://x.example/b?sig=SECRET2');
    target.log('[FETCH] https://x.example/c?sig=SECRET3');
    target.log('%o', { url: 'https://x.example/d?sig=SECRET4' });
    target.log('GET', '/login?token=SECRET5');
    uninstall();
    expect(msgs()).toEqual([
      'open https://x.example/a',
      'fetch https://x.example/b',
      'https://x.example/c',
      "{ url: 'https://x.example/d' }",
      'GET /login',
    ]);
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('leaves nothing secret of a real failed axios request: no query, no body password, no header', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = 403;
        res.end('no');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login?access_token=ACCESS-SECRET`;
    const err = (await axios
      .post(url, { username: 'ross', password: 'hunter2' }, { headers: { Authorization: 'Bearer abcdefghijklmnop' } })
      .catch((error: unknown) => error)) as AxiosError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(err).toBeInstanceOf(AxiosError);
    class Attempt {
      site = 'orzgk';
      constructor(public error: unknown) {}
    }

    const { log, target, uninstall, lines, parsed } = bridged();
    log.warn({ config: err.config }, 'retry');
    log.warn('attempt', new Attempt(err));
    target.error('login failed', err);
    target.error('login failed %o', err);
    target.error('attempt', new Attempt(err));
    target.error('retry', { config: err.config });
    // The two config values that carried a secret, on their own so the 1000-character cap cannot hide them.
    log.warn({ url: err.config?.url, data: err.config?.data }, 'request');
    uninstall();
    expect(lines).toHaveLength(7);
    expect(lines.join('\n')).not.toMatch(/hunter2|ACCESS-SECRET|abcdefghijklmnop/);
    const request = parsed()[6];
    expect(request.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login$/);
    expect(JSON.parse(request.data as string)).toEqual({ username: 'ross', password: '[REDACTED]' });
  });
});

describe('JSON strings are key-redacted wherever they are printed', () => {
  it('in a field, a message part and a JSON string inside another', () => {
    const { log, lines, parsed } = logger();
    log.info({ body: '{"password":"hunter2","site":"orzgk"}' }, 'resp');
    log.info('resp', '{"token":"zzz-tok"}');
    log.info({ body: JSON.stringify({ inner: JSON.stringify({ password: 'hunter2' }) }) });
    log.info({ pretty: JSON.stringify({ a: 1, b: [1, 2] }, null, 2) });
    log.info({ list: '[{"cookie":"sid=1"}]', broken: '{"password":"hunter2"' });
    log.info({ note: 'resp {"password":"hunter2"} done' });
    log.info({ padded: '  {"password":"hunter2"}\n' });
    const out = parsed();
    expect(out[0].body).toBe('{"password":"[REDACTED]","site":"orzgk"}');
    expect(out[1].msg).toBe('resp {"token":"[REDACTED]"}');
    expect(out[2].body).toBe(JSON.stringify({ inner: JSON.stringify({ password: '[REDACTED]' }) }));
    expect(out[3].pretty).toBe('{"a":1,"b":[1,2]}');
    expect(out[4].list).toBe('[{"cookie":"[REDACTED]"}]');
    // Not a whole JSON document: only the value patterns apply, as for any text (the documented limit).
    expect(out[4].broken).toBe('{"password":"hunter2"');
    expect(out[5].note).toBe('resp {"password":"hunter2"} done');
    expect(out[6].padded).toBe('{"password":"[REDACTED]"}');
    expect(lines.slice(0, 4).join('\n')).not.toMatch(/hunter2|zzz-tok|sid=1/);
  });

  it('in printf arguments and after a printf format (console bridge)', () => {
    const { target, uninstall, lines, msgs } = bridged();
    target.log('resp %s', JSON.stringify({ token: 'zzz-tok', password: 'hunter2' }));
    target.log('status %d', 403, '{"password":"hunter2"}');
    target.log('body %j', '{"password":"hunter2"}');
    uninstall();
    expect(msgs()).toEqual([
      'resp {"token":"[REDACTED]","password":"[REDACTED]"}',
      'status 403 {"password":"[REDACTED]"}',
      'body "{\\"password\\":\\"[REDACTED]\\"}"',
    ]);
    expect(lines.join('\n')).not.toMatch(/hunter2|zzz-tok/);
  });

  it('reads a JSON string that starts with a byte-order mark', () => {
    const { log, lines, parsed } = logger();
    log.info({ body: '﻿{"password":"hunter2"}' });
    expect(parsed()[0].body).toBe('{"password":"[REDACTED]"}');
    expect(lines[0]).not.toContain('hunter2');
  });

  it('stops parsing JSON held in strings four levels down and prints a marker, never the text', () => {
    let doc: unknown = { password: 'hunter2' };
    for (let level = 0; level < 4; level += 1) doc = { s: JSON.stringify(doc) };
    const { log, lines, parsed } = logger();
    log.info({ body: JSON.stringify(doc) });
    let text = parsed()[0].body as string;
    for (let level = 0; level < 4; level += 1) text = (JSON.parse(text) as { s: string }).s;
    expect(text).toBe('[truncated:max-depth]');
    expect(lines[0]).not.toContain('hunter2');
  });
});

describe("an Error's message is printed by the one policy wherever it appears", () => {
  const JSON_MESSAGE = JSON.stringify({ user: 'u', password: 'hunter2' });
  const REDACTED_JSON = '{"user":"u","password":"[REDACTED]"}';
  /** The start of an Error printed as an object, through to its first stack frame. */
  const errorHead = (message: unknown, stackHead: string, name = 'Error'): string =>
    JSON.stringify({ name, message, stack: `${stackHead}\n    at ` }).slice(0, -2);
  const start = (value: unknown, length: number): string => String(value).slice(0, length);

  it('in console.error(err) and an Error message part, as in err.message', () => {
    const { log, target, uninstall, lines, parsed, msgs } = bridged();
    target.error(new Error(JSON_MESSAGE));
    target.error(new Error('/api/lookup?token=hunter3'));
    target.error(new Error('Cookie: sid=hunter4'));
    log.info('failed:', new Error(JSON_MESSAGE));
    log.warn('retry after', new Error('/api/lookup?token=hunter3'));
    log.error('during', new Error('Cookie: sid=hunter4'));
    log.info('empty', new Error(''));
    uninstall();
    expect(msgs()).toEqual([
      `Error: ${REDACTED_JSON}`,
      'Error: /api/lookup',
      'Error: Cookie: [REDACTED]',
      `failed: ${REDACTED_JSON}`,
      'retry after /api/lookup',
      'during Cookie: [REDACTED]',
      'empty Error (no message)',
    ]);
    expect(parsed().slice(0, 3).map((line) => line.err)).toEqual([
      { type: 'Error', message: REDACTED_JSON },
      { type: 'Error', message: '/api/lookup' },
      { type: 'Error', message: 'Cookie: [REDACTED]' },
    ]);
    expect(lines.join('\n')).not.toMatch(/hunter/);
  });

  it('in the stack of an Error printed as an object: a field, nested, and under %s, %o, %O and %j', () => {
    const { log, target, uninstall, lines, parsed, msgs } = bridged();
    log.info({ cause: new Error(JSON_MESSAGE) });
    log.info({ attempt: { cause: new Error('Cookie: sid=hunter4') } });
    target.error('failed %s', new Error(JSON_MESSAGE));
    target.error('failed %o', new Error('/api/lookup?token=hunter3'));
    target.error('failed %O', new Error('Cookie: sid=hunter4'));
    target.error('failed %j', new Error(JSON_MESSAGE));
    uninstall();
    expect(lines.join('\n')).not.toMatch(/hunter/);
    const [cause, attempt] = parsed();
    const head = errorHead(REDACTED_JSON, `Error: ${REDACTED_JSON}`);
    expect(start(cause.cause, head.length)).toBe(head);
    const nested = `{"cause":${errorHead('Cookie: [REDACTED]', 'Error: Cookie: [REDACTED]')}`;
    expect(start(attempt.attempt, nested.length)).toBe(nested);
    const printf = [
      `failed { name: 'Error', message: '${REDACTED_JSON}', stack: 'Error: ${REDACTED_JSON}\\n    at `,
      "failed { name: 'Error', message: '/api/lookup', stack: 'Error: /api/lookup\\n    at ",
      "failed { name: 'Error', message: 'Cookie: [REDACTED]', stack: 'Error: Cookie: [REDACTED]\\n    at ",
      `failed ${head}`,
    ];
    expect(msgs().slice(2).map((msg, index) => start(msg, printf[index].length))).toEqual(printf);
  });

  it("keeps a stack's own header (a node error code) and rewrites one that no longer matches the message", () => {
    // Node's own errors put their code in the header: 'RangeError [ERR_OUT_OF_RANGE]: The value of ...'. (A node
    // core error is from another realm under jest, so this one is made here, with node's header.)
    const coded = Object.assign(new RangeError('Cookie: sid=hunter5'), { code: 'ERR_EXAMPLE' });
    coded.stack = 'RangeError [ERR_EXAMPLE]: Cookie: sid=hunter5\n    at check (/app/dist/index.js:1:1)';
    const stale = new Error('Cookie: sid=hunter6');
    void stale.stack; // V8 writes the stack's header when it is first read.
    stale.message = 'wrapped';
    const custom = Object.assign(new Error('m'), { stack: 'trace from /login?token=hunter7' });
    const emptied = new Error('Cookie: sid=hunter9: ');
    void emptied.stack;
    emptied.message = '';
    const suffix = new Error('rotate password=hunter10 then retry');
    void suffix.stack;
    suffix.message = 'then retry';
    const bare = new Error('Cookie: sid=hunter11');
    delete (bare as { stack?: string }).stack;
    const odd = new Error('x');
    (odd as { message: unknown }).message = { password: 'hunter8' };
    const { log, target, uninstall, lines, parsed, msgs } = bridged();
    log.info({ coded, stale, custom, odd, emptied, suffix, bare });
    target.error('odd', odd);
    log.info('odd', odd);
    uninstall();
    expect(lines.join('\n')).not.toMatch(/hunter/);
    const [line] = parsed();
    expect(line.coded).toBe(
      JSON.stringify({ name: 'RangeError', message: 'Cookie: [REDACTED]', stack: 'RangeError [ERR_EXAMPLE]: Cookie: [REDACTED]\n    at check (/app/dist/index.js:1:1)' }),
    );
    const staleHead = errorHead('wrapped', 'Error: wrapped');
    expect(start(line.stale, staleHead.length)).toBe(staleHead);
    expect(line.custom).toBe('{"name":"Error","message":"m","stack":"Error: m"}');
    const oddHead = errorHead({ password: '[REDACTED]' }, 'Error');
    expect(start(line.odd, oddHead.length)).toBe(oddHead);
    // An empty message: V8's header is the name alone.
    const emptiedHead = errorHead('', 'Error');
    expect(start(line.emptied, emptiedHead.length)).toBe(emptiedHead);
    // The header ends with the new message, but not after ': ', so it is not the header V8 wrote for it.
    const suffixHead = errorHead('then retry', 'Error: then retry');
    expect(start(line.suffix, suffixHead.length)).toBe(suffixHead);
    expect(line.bare).toBe('{"name":"Error","message":"Cookie: [REDACTED]"}');
    expect(msgs().slice(1)).toEqual(['odd Error: {"password":"[REDACTED]"}', 'odd {"password":"[REDACTED]"}']);
  });

  it("keeps every line of a multi-line message in the stack's header, one holding ' at ' too", () => {
    const { log, lines, parsed } = logger();
    log.info({ cause: new Error('Cookie: sid=hunter12\nfailed at noon') });
    expect(lines[0]).not.toContain('hunter12');
    const head = errorHead('Cookie: [REDACTED]\nfailed at noon', 'Error: Cookie: [REDACTED]\nfailed at noon');
    expect(start(parsed()[0].cause, head.length)).toBe(head);
  });

  it("prints an Error's stack under a URL-named key as its message is, a URL value", () => {
    const { log, lines, parsed } = logger();
    log.info({ url: new Error('see docs?sig=hunter1') });
    expect(lines[0]).not.toContain('hunter1');
    const head = errorHead('see docs', 'Error: see docs');
    expect(start(parsed()[0].url, head.length)).toBe(head);
  });
});

describe('a form-encoded body (key=value&key=value) has each sensitive value masked', () => {
  const FORM = 'grant_type=password&username=u&password=hunter5&client_secret=hunter6';
  const MASKED = 'grant_type=password&username=u&password=[REDACTED]&client_secret=[REDACTED]';

  it('as a field, nested, a message, a message part, and a bridged or printf argument', () => {
    const { log, target, uninstall, lines, parsed, msgs } = bridged();
    log.warn({ config: { url: '/oauth/token', data: FORM } });
    log.info({ body: 'api%5Fkey=hunter7&session%2Did=hunter8&a=1', odd: '%E0%A4%A=1&token%=hunter9&=x&flag' });
    log.info(FORM);
    log.info('sent', FORM);
    target.log('sent', FORM);
    target.log('sent %s', FORM);
    target.log({ data: `  ${FORM}\n` });
    uninstall();
    expect(lines.join('\n')).not.toMatch(/hunter/);
    const out = parsed();
    expect(out[0].config).toBe(JSON.stringify({ url: '/oauth/token', data: MASKED }));
    // A key is read decoded (api_key, session-id); one that does not decode is read as written.
    expect(out[1]).toMatchObject({ body: 'api%5Fkey=[REDACTED]&session%2Did=[REDACTED]&a=1', odd: '%E0%A4%A=1&token%=[REDACTED]&=x&flag' });
    expect(msgs().slice(2)).toEqual([MASKED, `sent ${MASKED}`, `sent ${MASKED}`, `sent ${MASKED}`, JSON.stringify({ data: MASKED })]);
  });

  it('leaves text that is not wholly a form alone', () => {
    const { log, parsed } = logger();
    log.info({ list: 'a=1&b=2', prose: 'retry with password=visible', word: 'token', base64: 'aGk=' });
    // A pair with no '=' has no key to read; a form with nothing to mask keeps its padding.
    log.info({ flag: 'a=1&passwordless', padded: ' a=1&b=2 ' });
    const out = parsed();
    expect(out[0]).toMatchObject({ list: 'a=1&b=2', prose: 'retry with password=visible', word: 'token', base64: 'aGk=' });
    expect(out[1]).toMatchObject({ flag: 'a=1&passwordless', padded: ' a=1&b=2 ' });
  });

  it('masks a real axios URLSearchParams body in config.data, logged as the axios README logs error.config', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = 401;
        res.end('no');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const body = new URLSearchParams({ grant_type: 'password', username: 'ross', password: 'FORMPW-SECRET', client_secret: 'CSECRET-SECRET' });
    const err = (await axios.post(`http://127.0.0.1:${port}/oauth/token`, body).catch((error: unknown) => error)) as AxiosError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(err).toBeInstanceOf(AxiosError);
    expect(err.config?.data).toBe('grant_type=password&username=ross&password=FORMPW-SECRET&client_secret=CSECRET-SECRET');
    const { log, target, uninstall, lines, parsed } = bridged();
    log.warn({ data: err.config?.data }, 'token request failed');
    target.log(err.config);
    uninstall();
    expect(lines.join('\n')).not.toMatch(/[A-Z]+-SECRET/);
    expect(parsed()[0].data).toBe('grant_type=password&username=ross&password=[REDACTED]&client_secret=[REDACTED]');
  });
});

describe('an object that hides itself from util.inspect prints as its class name', () => {
  class Credential {
    constructor(public value: string) {}
    [inspect.custom](): string {
      return 'Credential<hidden>';
    }
  }
  class Holder {
    constructor(public inner: unknown) {}
  }

  it('in every argument position and as a field, at the top and nested', () => {
    const cred = new Credential('hunter2');
    const { log, target, uninstall, lines, parsed, msgs } = bridged();
    target.log('using %o', cred);
    target.log('using %s', cred);
    target.log('using', cred);
    target.log('%o', { cred });
    target.log('held', new Holder(cred));
    log.info('part', cred);
    log.info({ cred }, 'field');
    uninstall();
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(msgs()).toEqual([
      "using '[Credential]'",
      'using [Credential]',
      'using [Credential]',
      "{ cred: '[Credential]' }",
      'held {"inner":"[Credential]"}',
      'part [Credential]',
      'field',
    ]);
    expect(parsed()[6].cred).toBe('[Credential]');
  });

  it('names one with no class "object", and honours a toJSON over util.inspect.custom', () => {
    const bare = Object.assign(Object.create(null) as object, { value: 'hunter2', [inspect.custom]: () => 'bare' });
    const anonymous = new (class {
      value = 'hunter2';
      [inspect.custom](): string {
        return 'anonymous';
      }
    })();
    const shown = new (class Token {
      value = 'hunter2';
      [inspect.custom](): string {
        return 'Token<hidden>';
      }
      toJSON(): object {
        return { kind: 'token' };
      }
    })();
    const { target, uninstall, lines, msgs } = bridged();
    target.log('bare', bare);
    target.log('anonymous', anonymous);
    target.log('shown', shown);
    uninstall();
    expect(lines.join('\n')).not.toContain('hunter2');
    expect(msgs()).toEqual(['bare [object]', 'anonymous [object]', 'shown {"kind":"token"}']);
  });
});

describe('printing a value never throws and stays bounded', () => {
  class Getter {
    cookie = 'sid=S3CRET';
    constructor() {
      Object.defineProperty(this, 'boom', {
        enumerable: true,
        get() {
          throw new Error('getter threw');
        },
      });
    }
  }

  it('stops reading a graph of shared references after a fixed number of entries per value', () => {
    let reads = 0;
    const leaf = Object.defineProperty({}, 'v', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    // 40 keys per level, all the same object: 40^3 = 64,000 leaves (128,000 reads) without a budget.
    let node: object = leaf;
    for (let level = 0; level < 3; level += 1) {
      const shared = node;
      node = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, shared]));
    }
    const { log, parsed } = logger();
    log.info({ graph: node });
    expect(reads).toBeLessThan(1_000);
    expect(parsed()[0].graph as string).toMatch(/^\{"k0":\{"k0":\{"k0":\{"v":1\}/);
  });

  it('reads 1000 entries of one value, all levels together, and no more', () => {
    const value = (lastSize: number) => {
      const reads = { count: 0 };
      const last = Object.defineProperty(
        Object.fromEntries(Array.from({ length: lastSize - 1 }, (_, i) => [`k${i}`, 0])),
        'probe',
        {
          enumerable: true,
          get: () => {
            reads.count += 1;
            return 0;
          },
        },
      );
      return { list: [...Array.from({ length: 9 }, () => new Array<number>(100).fill(0)), last], reads };
    };
    const exact = value(90); // 10 + 9 * 100 + 90 = 1000 entries
    const over = value(91); // 1001
    const { log } = logger();
    log.info({ exact: exact.list, over: over.list });
    expect(exact.reads.count).toBeGreaterThan(0);
    expect(over.reads.count).toBe(0);
  });

  it('reads a JSON string once per printed value, however many times the value refers to it', () => {
    // Spaced, so the parse of each source string is told apart from the logger's own compact round trip.
    const inner = '[1, 2]';
    const outer = JSON.stringify([inner, inner, inner], null, 1);
    const { log, parsed } = logger();
    const parse = jest.spyOn(JSON, 'parse');
    let documents = -1;
    try {
      log.info({ v: [outer, outer, outer] });
      documents = parse.mock.calls.filter(([text]) => text === inner || text === outer).length;
    } finally {
      parse.mockRestore();
    }
    expect(documents).toBe(2);
    expect(parsed()[0].v).toBe(JSON.stringify(new Array<string>(3).fill('["[1,2]","[1,2]","[1,2]"]')));
  });

  it('counts JSON held in strings against the same 1000 entries as the value around it, a reused one each time', () => {
    // 20 different JSON strings of 99 entries inside one JSON string: 20 + 9 * 99 = 911 entries read, the
    // tenth string goes past 1000 (it prints the marker) and the other ten are never parsed.
    const different = Array.from({ length: 20 }, (_, n) => JSON.stringify(new Array<number>(99).fill(n), null, 1));
    // One such string 20 times: read once, then reused at 99 entries each until the budget is short.
    const reused = JSON.stringify(new Array<string>(99).fill('x'), null, 1);
    const { log } = logger();
    const parse = jest.spyOn(JSON, 'parse');
    let counts: number[] = [];
    try {
      log.info({ different: JSON.stringify(different), reused: JSON.stringify(new Array<string>(20).fill(reused)) });
      const texts = parse.mock.calls.map(([text]) => text as unknown);
      counts = [texts.filter((text) => different.includes(text as string)).length, texts.filter((text) => text === reused).length];
    } finally {
      parse.mockRestore();
    }
    // reused: 20 + 99 read, 8 reuses (911 in all), then too few entries are left to reuse it: read once more.
    expect(counts).toEqual([10, 2]);
  });

  it('still reads a JSON string reached with no entries left, when it needs none', () => {
    // 11 + 9 * 100 + 89 = 1000 entries: the budget is exactly spent when the JSON string comes.
    const empty = ' [ ]';
    const { log } = logger();
    const parse = jest.spyOn(JSON, 'parse');
    let reads = -1;
    try {
      log.info({ v: [...Array.from({ length: 9 }, () => new Array<number>(100).fill(0)), new Array<number>(89).fill(0), empty] });
      reads = parse.mock.calls.filter(([text]) => text === empty.trim()).length;
    } finally {
      parse.mockRestore();
    }
    expect(reads).toBe(1);
  });

  it("counts a JSON string's entries against the object around it", () => {
    // 2 + 9 + 9 * 100 = 911 entries before body; body's 90 go past 1000, so the JSON string inside it is never read.
    const inner = ' [1, 2]';
    const body = JSON.stringify([inner, ...new Array<number>(89).fill(0)]);
    const { log } = logger();
    const parse = jest.spyOn(JSON, 'parse');
    let reads = -1;
    try {
      log.info({ v: { list: Array.from({ length: 9 }, () => new Array<number>(100).fill(0)), body } });
      reads = parse.mock.calls.filter(([text]) => text === inner.trim()).length;
    } finally {
      parse.mockRestore();
    }
    expect(reads).toBe(0);
  });

  it('reuses a printed string only as the same kind of value at the same depth', () => {
    const { log, parsed } = logger();
    // As a URL value the text is cut at its ?; as plain text it is kept.
    log.info({ v: { link: 'page 2?cursor=abc', note: 'page 2?cursor=abc' } });
    // The same JSON string one level down and four levels down (where JSON is no longer read).
    const same = '[1]';
    log.info({ v: JSON.stringify([same, JSON.stringify([JSON.stringify([JSON.stringify([same])])])]) });
    const out = parsed();
    expect(out[0].v).toBe('{"link":"page 2","note":"page 2?cursor=abc"}');
    expect(out[1].v).toBe(JSON.stringify([same, JSON.stringify([JSON.stringify([JSON.stringify(['[truncated:max-depth]'])])])]));
  });

  it('prints a reused plain string once per printed value, past the budget too', () => {
    // Ten JSON strings of 99 entries use the budget up; the 50 references to one plain string after them are
    // printed from the first printing. Its secret shape changes it, so the final key-redaction pass reads
    // only the printed text.
    const plain = `Bearer abcdefghijklmnop ${'x'.repeat(1000)}`;
    const docs = Array.from({ length: 11 }, (_, n) => JSON.stringify(new Array<number>(99).fill(n)));
    const { log, lines } = logger();
    const read = jest.spyOn(sanitize, 'redactString');
    let reads = -1;
    try {
      log.info({ v: [...docs, ...new Array<string>(50).fill(plain)] });
      reads = read.mock.calls.filter(([text]) => text === plain).length;
    } finally {
      read.mockRestore();
    }
    expect(reads).toBe(1);
    expect(lines[0]).not.toContain('abcdefghijklmnop');
  });

  it('prints an object it cannot read as [unserializable], per value', () => {
    const { log, target, uninstall, parsed, msgs } = bridged();
    expect(() => {
      target.log('x', new Getter());
      target.log('%o', new Getter());
      log.info('x', new Getter());
      log.info({ f: new Getter(), ok: 1 }, 'field');
    }).not.toThrow();
    uninstall();
    expect(msgs()).toEqual(['x [unserializable]', "'[unserializable]'", 'x [unserializable]', 'field']);
    expect(parsed()[3]).toMatchObject({ f: '[unserializable]', ok: 1 });
  });

  it('writes a line saying [unserializable] when the call itself cannot be read (a revoked Proxy)', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const { log, target, uninstall, parsed } = bridged();
    expect(() => {
      // A bad binding is left out of the fallback line, so the fallback itself cannot throw.
      log.child({ err: proxy }).info('bound');
      log.info(proxy);
      log.warn('x', proxy);
      log.error({ p: proxy }, 'field');
      target.log(proxy);
      target.log('%o', proxy);
    }).not.toThrow();
    uninstall();
    const out = parsed();
    expect(out.map((line) => [line.level, line.msg])).toEqual([
      ['info', '[unserializable]'],
      ['info', '[unserializable]'],
      ['warn', '[unserializable]'],
      ['error', 'field'],
      ['info', '[unserializable]'],
      ['info', '[unserializable]'],
    ]);
    expect(out[3].p).toBe('[unserializable]');
    expect(out.map((line) => line.event)).toEqual(['app.log', 'app.log', 'app.log', 'app.log', 'app.console', 'app.console']);
    out.forEach(expectValidLine);
  });

  it('prints binary data as [binary] wherever it appears, as a field already does', () => {
    const { log, target, uninstall, parsed, msgs } = bridged();
    log.info({ body: Buffer.from('sid=hunter2') }, 'field');
    log.info('body', Buffer.from('Cookie: sid=hunter2'));
    target.log('body', new TextEncoder().encode('sid=hunter2'));
    target.log('body %o', Buffer.from('sid=hunter2'));
    target.log('raw', new ArrayBuffer(4));
    target.log('held', new (class Upload {
      name = 'a.jpg';
      data = Buffer.from('sid=hunter2');
    })());
    uninstall();
    expect(parsed()[0].body).toBe('[binary]');
    expect(msgs()).toEqual([
      'field',
      'body [binary]',
      'body [binary]',
      "body '[binary]'",
      'raw [binary]',
      'held {"name":"a.jpg","data":"[binary]"}',
    ]);
  });

  it('prints an Error held by another object as {name, message, stack}, never its own properties', () => {
    class HttpErr extends Error {
      headers = { cookie: 'sid=S3CRET' };
      constructor() {
        super('403 from https://x.example/a?sig=S3CRET');
        this.name = 'HttpErr';
      }
    }
    class Attempt {
      site = 'orzgk';
      cause = new HttpErr();
    }
    const { log, target, uninstall, lines, parsed, msgs } = bridged();
    target.log('attempt', new Attempt());
    log.info({ attempt: new Attempt() });
    uninstall();
    expect(lines.join('\n')).not.toMatch(/S3CRET|headers/);
    const head = '{"site":"orzgk","cause":{"name":"HttpErr","message":"403 from https://x.example/a","stack":"';
    expect(msgs()[0]).toMatch(new RegExp(`^attempt ${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(parsed()[1].attempt as string).toMatch(new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('prints bigint and symbol values held by an object, as a field does', () => {
    const { target, uninstall, msgs } = bridged();
    target.log('big', new (class Big {
      n = BigInt(10);
      password = 'hunter2';
      tag = Symbol('t');
    })());
    target.log('list', [() => 1, new URL('https://x.example/a?sig=1')]);
    target.log('sparse', { a: 1, gone: undefined, none: null }, [undefined, null]);
    uninstall();
    expect(msgs()).toEqual([
      'big {"n":"10n","password":"[REDACTED]","tag":"[symbol]"}',
      'list ["[function]","https://x.example/a"]',
      'sparse {"a":1,"none":null} [null,null]',
    ]);
  });

  it('keeps 100 entries of an array or object, the last one counting the rest, and never serialises the rest', () => {
    const serialised: number[] = [];
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      toJSON: () => {
        serialised.push(index);
        return index;
      },
    }));
    const hundred = Array.from({ length: 100 }, (_, index) => index);
    const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`a${index}`, 0]));
    const { log, target, uninstall, parsed, msgs } = bridged();
    target.log('rows', rows);
    target.log('hundred', hundred);
    target.log('wide', keys(150));
    target.log('keys', keys(100));
    log.info({ page: new (class Page {
      rows = rows;
    })() });
    uninstall();
    expect(serialised).toEqual([...Array.from({ length: 99 }, (_, index) => index), ...Array.from({ length: 99 }, (_, index) => index)]);
    const first99 = Array.from({ length: 99 }, (_, index) => index);
    expect(msgs().slice(0, 4)).toEqual([
      `rows ${JSON.stringify([...first99, '[truncated:901 more]'])}`,
      `hundred ${JSON.stringify(hundred)}`,
      `wide ${JSON.stringify({ ...keys(99), '[truncated]': '51 more' })}`,
      `keys ${JSON.stringify(keys(100))}`,
    ]);
    expect(parsed()[4].page).toBe(JSON.stringify({ rows: [...first99, '[truncated:901 more]'] }));
  });

  it('strips request targets in linear time: a run of "GET:" never rescans the text after it', () => {
    // 400 different 8,000-character message parts (under the 8,192 cap): about 2 s when each GET: rescans the rest
    // of its part (quadratic), tens of ms in linear time. The bound leaves a wide margin both ways.
    const parts = Array.from({ length: 400 }, (_, index) => `${'GET:'.repeat(2000)}${index}`);
    const { log, parsed } = logger();
    const started = performance.now();
    log.info(...parts);
    expect(performance.now() - started).toBeLessThan(500);
    expect((parsed()[0].msg as string).startsWith('GET:GET:')).toBe(true);
  });

  it('never reads an object past the fourth level', () => {
    const deep = { a: { b: { c: { d: { get e(): never {
      throw new Error('read past the depth limit');
    } } } } } };
    const { log, target, uninstall, parsed, msgs } = bridged();
    target.log('deep', deep);
    log.info({ deep });
    uninstall();
    expect(msgs()[0]).toBe('deep {"a":{"b":{"c":{"d":"[truncated:max-depth]"}}}}');
    expect(parsed()[1].deep).toBe('{"a":{"b":{"c":{"d":"[truncated:max-depth]"}}}}');
  });

  it('counts the depth through an array it shortened', () => {
    const rows = Array.from({ length: 150 }, () => ({ a: { b: { c: 1 } } }));
    const { target, uninstall, msgs } = bridged();
    target.log('rows', { rows });
    uninstall();
    expect((msgs()[0] as string).startsWith('rows {"rows":[{"a":{"b":"[truncated:max-depth]"}},')).toBe(true);
  });
});
