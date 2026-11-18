import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../src/server/log';
import { DEFAULT_SENSITIVE_KEY_PATTERN, redactAttributes, redactValue } from '../../src/utils/sanitize';
import { captureSink } from '../server/helpers';

// The key lists are shared with media-manager's Python port of this pattern (app/telemetry/redact.py SENSITIVE_KEY):
// tests/fixtures/sensitive-keys.json there is a byte-for-byte copy, read by its tests/test_telemetry_sensitive_keys.py.
const KEYS: { redact: string[]; keep: string[]; released: string[]; limit: string[] } = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/sensitive-keys.json'), 'utf8'),
);

/** The pattern as fc-shared 1.10.0 shipped it: 'otp' anywhere in a key. */
const BEFORE =
  /pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|authorization|credential|cookie|session[-_]?id|bearer|otp|passphrase|\bpin\b|\bssn\b|\bmfa\b/i;
/** The same without its 'otp' alternative: what every other alternative redacts. */
const BEFORE_WITHOUT_OTP = new RegExp(BEFORE.source.replace('|otp|', '|'), 'i');

const sensitive = (key: string): boolean => DEFAULT_SENSITIVE_KEY_PATTERN.test(key);

describe('the otp key is anchored to a segment of the key', () => {
  it('keeps footprint, footprintMm, laptop and captopril', () => {
    const fields = { footprint: 0.42, footprintMm: 118, claim_footprint: 0.6, laptop: 'x1', captopril: '25mg' };
    expect(redactValue(fields)).toEqual(fields);
    expect(redactAttributes(fields)).toEqual(fields);
  });

  it('still redacts otp, otp_code, otpCode, totp, x-otp and mfa.otp', () => {
    const fields = { otp: '1', otp_code: '2', otpCode: '3', totp: '4', 'x-otp': '5', 'mfa.otp': '6' };
    const masked = Object.fromEntries(Object.keys(fields).map((key) => [key, '[REDACTED]']));
    expect(redactValue(fields)).toEqual(masked);
    expect(redactAttributes(fields)).toEqual(masked);
  });

  it('prints a footprint field of a server log line, and masks its otp fields', () => {
    const capture = captureSink();
    const log = createLogger({ service: 'media-manager', version: '1.0.0', env: {}, sink: capture.sink });
    log.info({ event: 'stage', claim_footprint: 0.6, footprintMm: 118, otpCode: '493817', userOtp: '493818' });
    log.info('timings', { footprint: 0.42, totp: '493819' });
    const [fields, text] = capture.parsed();
    expect(fields).toMatchObject({ claim_footprint: 0.6, footprint_mm: 118, otp_code: '[REDACTED]', user_otp: '[REDACTED]' });
    expect(text.msg).toBe('timings {"footprint":0.42,"totp":"[REDACTED]"}');
  });

  it.each(KEYS.redact)('redacts %s, as before', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(true);
    expect(redactValue({ [key]: 'hunter2' })).toEqual({ [key]: '[REDACTED]' });
  });

  it.each(KEYS.keep)('keeps %s, as before', (key) => {
    expect(BEFORE.test(key)).toBe(false);
    expect(sensitive(key)).toBe(false);
  });

  it.each(KEYS.released)('no longer redacts %s', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(false);
    expect(redactValue({ [key]: 'visible' })).toEqual({ [key]: 'visible' });
  });

  // Known limit: a case-insensitive pattern cannot see a camelCase hump, so 'otp' with a letter on both sides is one
  // word whether it reads userOtpCode or footprint. hotp before a letter is kept too: hotPath is a word, hotpCounter rare.
  it.each(KEYS.limit)('known limit: no longer redacts %s', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(false);
  });
});

describe('nothing but a mid-word otp is released', () => {
  const prefixes = ['', 'x-', 'user_', 'user.', 'user', 'User', 'v2', '2'];
  const suffixes = ['', '_id', '-id', '.value', 'Value', 'value', '2', '_2'];
  const cases = [(key: string) => key, (key: string) => key.toUpperCase(), (key: string) => key.toLowerCase()];
  const corpus = [...KEYS.redact, ...KEYS.keep, ...KEYS.released, ...KEYS.limit].flatMap((key) =>
    prefixes.flatMap((prefix) => suffixes.flatMap((suffix) => cases.map((recase) => recase(prefix + key + suffix)))),
  );

  it('over every fixture key with a prefix, a suffix and a case change', () => {
    const widened: string[] = [];
    const wronglyReleased: string[] = [];
    let released = 0;
    for (const key of corpus) {
      const before = BEFORE.test(key);
      const after = sensitive(key);
      if (after && !before) widened.push(key);
      if (before && !after) {
        released += 1;
        // Released only when no other alternative matched and every otp in the key has a letter on both sides.
        const midWord = (key.match(/otp/gi) ?? []).length === (key.match(/[a-z]otp(?=[a-z])/gi) ?? []).length;
        if (BEFORE_WITHOUT_OTP.test(key) || !midWord) wronglyReleased.push(key);
      }
    }
    expect(corpus.length).toBeGreaterThan(20000);
    expect(released).toBeGreaterThan(1000);
    expect(widened).toEqual([]);
    expect(wronglyReleased).toEqual([]);
  });

  it('keeps every other alternative of the 1.10.0 pattern', () => {
    const before = BEFORE.source.split('|').filter((alternative) => alternative !== 'otp');
    const after = DEFAULT_SENSITIVE_KEY_PATTERN.source.split('|');
    expect(before).toHaveLength(17);
    for (const alternative of before) expect(after).toContain(alternative);
    expect(DEFAULT_SENSITIVE_KEY_PATTERN.flags).toBe('i');
  });

  it('still composes by its source, as fc-coordinator extends it', () => {
    const extended = new RegExp(`${DEFAULT_SENSITIVE_KEY_PATTERN.source}|(?:^|[.\\-_])dpop$`, 'i');
    for (const key of [...KEYS.redact, 'dpop', 'x-dpop']) expect(extended.test(key)).toBe(true);
    for (const key of [...KEYS.keep, ...KEYS.released]) expect(extended.test(key)).toBe(false);
  });
});
