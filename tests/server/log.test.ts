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
    ['a protocol-relative URL', '//cdn.example/i.jpg?sig=SECRET', '//cdn.example/i.jpg'],
    ['a URL inside text', 'retry https://x.example/a?sig=SECRET in 5s', 'retry https://x.example/a in 5s'],
    ['a URL glued to a word', 'src=https://x.example/a?sig=SECRET', 'src=https://x.example/a'],
    ['two URLs', 'from https://a.example/?k=SECRET to http://b.example/c#SECRET', 'from https://a.example/ to http://b.example/c'],
    ['a quoted URL', "open 'https://x.example/a?sig=SECRET' now", "open 'https://x.example/a' now"],
  ])('strips %s', (_label, value, expected) => {
    const { log, lines, parsed } = logger();
    log.info({ link: value });
    expect(parsed()[0].link).toBe(expected);
    expect(lines[0]).not.toContain('SECRET');
  });

  it.each([
    ['a URL with nothing to strip keeps its exact text', 'https://X.example'],
    ['a file URL', 'file:///app/dist/server.mjs:10:5'],
    ['a question in text', 'why? because'],
    ['a word with a question mark', 'a?b'],
    ['a path followed by text', '/a b?c'],
  ])('leaves %s alone', (_label, value) => {
    const { log, parsed } = logger();
    log.info({ link: value });
    expect(parsed()[0].link).toBe(value);
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
    uninstall();
    expect(lines).toHaveLength(6);
    expect(lines.join('\n')).not.toMatch(/hunter2|ACCESS-SECRET|abcdefghijklmnop/);
    const config = JSON.parse(parsed()[0].config as string) as { url: string; data: string };
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login$/);
    expect(JSON.parse(config.data)).toEqual({ username: 'ross', password: '[REDACTED]' });
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
    const out = parsed();
    expect(out[0].body).toBe('{"password":"[REDACTED]","site":"orzgk"}');
    expect(out[1].msg).toBe('resp {"token":"[REDACTED]"}');
    expect(out[2].body).toBe(JSON.stringify({ inner: JSON.stringify({ password: '[REDACTED]' }) }));
    expect(out[3].pretty).toBe('{"a":1,"b":[1,2]}');
    expect(out[4].list).toBe('[{"cookie":"[REDACTED]"}]');
    // Not JSON: only the value patterns apply, exactly as for any text.
    expect(out[4].broken).toBe('{"password":"hunter2"');
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
      ['warn', '[unserializable]'],
      ['error', 'field'],
      ['info', '[unserializable]'],
      ['info', '[unserializable]'],
    ]);
    expect(out[2].p).toBe('[unserializable]');
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
    uninstall();
    expect(msgs()).toEqual([
      'big {"n":"10n","password":"[REDACTED]","tag":"[symbol]"}',
      'list ["[function]","https://x.example/a"]',
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
    expect(parsed()[4].page).toBe(JSON.stringify({ rows: [...first99, '[truncated:901 more]'] }).slice(0, 1000) + '...[truncated]');
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
});
