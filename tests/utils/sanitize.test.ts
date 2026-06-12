import {
  redactString,
  redactValue,
  redactAttributes,
  DEFAULT_SECRET_VALUE_PATTERNS,
} from '../../src/utils/sanitize';

describe('redactString', () => {
  it('masks Bearer tokens', () => {
    expect(redactString('Authorization: Bearer abc.def-123_xyz')).toBe('Authorization: [REDACTED]');
  });

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.s5Hdq8KmqZ0';
    expect(redactString(`token=${jwt}`)).toBe('token=[REDACTED]');
  });

  it('masks GitHub, Slack, AWS and Google credentials', () => {
    expect(redactString('ghp_0123456789abcdefghijABCDEFGHIJ012345')).toBe('[REDACTED]');
    expect(redactString('xoxb-1111111111-abcdefghij')).toBe('[REDACTED]');
    expect(redactString('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
    expect(redactString('AIzaSyD-1234567890abcdefghijklmnopqrstuv')).toBe('[REDACTED]');
  });

  it('leaves innocent strings unchanged', () => {
    expect(redactString('a normal log message about figure 42')).toBe('a normal log message about figure 42');
  });

  it('truncates over-long strings', () => {
    const long = 'x'.repeat(9000);
    const out = redactString(long, { maxStringLength: 100 });
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(out.length).toBe(100 + '…[truncated]'.length);
  });

  it('is stateless across calls (global regex lastIndex does not desync)', () => {
    const s = 'Bearer aaaaaaaaaa';
    // Calling repeatedly must yield identical results — guards the /g lastIndex trap.
    expect(redactString(s)).toBe('[REDACTED]');
    expect(redactString(s)).toBe('[REDACTED]');
    expect(redactString(s)).toBe('[REDACTED]');
  });

  it('honours a custom placeholder', () => {
    expect(redactString('Bearer xyzxyzxyzx', { placeholder: '***' })).toBe('***');
  });
});

describe('redactValue', () => {
  it('redacts values of sensitive keys wholesale', () => {
    const out = redactValue({
      username: 'rob',
      password: 'hunter2',
      apiKey: 'k-123',
      authorization: 'Bearer abc',
      session_id: 'sess-1',
    }) as Record<string, unknown>;
    expect(out.username).toBe('rob');
    expect(out.password).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.session_id).toBe('[REDACTED]');
  });

  it('scrubs secret shapes inside innocent-keyed strings', () => {
    const out = redactValue({ note: 'use ghp_0123456789abcdefghijABCDEFGHIJ012345 to auth' }) as Record<string, unknown>;
    expect(out.note).toBe('use [REDACTED] to auth');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactValue({
      outer: { inner: { token: 't' }, items: [{ secret: 's' }, 'ok'] },
    }) as any;
    expect(out.outer.inner.token).toBe('[REDACTED]');
    expect(out.outer.items[0].secret).toBe('[REDACTED]');
    expect(out.outer.items[1]).toBe('ok');
  });

  it('does not mutate the original object', () => {
    const original = { password: 'hunter2', nested: { token: 't' } };
    redactValue(original);
    expect(original.password).toBe('hunter2');
    expect(original.nested.token).toBe('t');
  });

  it('collapses circular references instead of throwing', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const out = redactValue(a) as any;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[circular]');
  });

  it('caps recursion depth', () => {
    const deep: any = { v: { v: { v: { v: {} } } } };
    const out = redactValue(deep, { maxDepth: 2 }) as any;
    expect(out.v.v).toBe('[truncated:max-depth]');
  });

  it('handles Error, Date, binary and primitive leaves', () => {
    const err = new Error('failed with token ghp_0123456789abcdefghijABCDEFGHIJ012345');
    const out = redactValue({
      err,
      when: new Date('2026-06-11T00:00:00.000Z'),
      bytes: new Uint8Array([1, 2, 3]),
      n: 7,
      ok: true,
      missing: null,
    }) as any;
    expect(out.err.name).toBe('Error');
    expect(out.err.message).toBe('failed with token [REDACTED]');
    expect(out.when).toBe('2026-06-11T00:00:00.000Z');
    expect(out.bytes).toBe('[binary]');
    expect(out.n).toBe(7);
    expect(out.ok).toBe(true);
    expect(out.missing).toBeNull();
  });
});

describe('redactAttributes', () => {
  it('redacts dotted sensitive attribute keys', () => {
    const out = redactAttributes({
      'http.method': 'GET',
      'http.request.header.authorization': 'Bearer abc',
      'db.statement': 'SELECT 1',
      'user.password': 'hunter2',
    });
    expect(out['http.method']).toBe('GET');
    expect(out['http.request.header.authorization']).toBe('[REDACTED]');
    expect(out['db.statement']).toBe('SELECT 1');
    expect(out['user.password']).toBe('[REDACTED]');
  });

  it('scrubs secret shapes in innocent-keyed string values', () => {
    const out = redactAttributes({ 'log.line': 'auth via ghp_0123456789abcdefghijABCDEFGHIJ012345' });
    expect(out['log.line']).toBe('auth via [REDACTED]');
  });

  it('handles array and non-string attribute values', () => {
    const out = redactAttributes({
      'http.flags': [1, 2, 3],
      'http.targets': ['ok', 'Bearer zzzzzzzzzz'],
      'http.status': 200,
      'http.ok': true,
    });
    expect(out['http.flags']).toEqual([1, 2, 3]);
    expect(out['http.targets']).toEqual(['ok', '[REDACTED]']);
    expect(out['http.status']).toBe(200);
    expect(out['http.ok']).toBe(true);
  });

  it('returns a new record without mutating the input', () => {
    const input = { 'user.token': 'abc' };
    const out = redactAttributes(input);
    expect(out['user.token']).toBe('[REDACTED]');
    expect(input['user.token']).toBe('abc');
  });
});

describe('exported defaults', () => {
  it('ships a non-empty set of secret value patterns', () => {
    expect(DEFAULT_SECRET_VALUE_PATTERNS.length).toBeGreaterThan(0);
  });
});
