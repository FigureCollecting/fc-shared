import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../src/server/log';
import {
  DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN,
  DEFAULT_SENSITIVE_KEY_PATTERN,
  redactAttributes,
  redactValue,
} from '../../src/utils/sanitize';
import { captureSink } from '../server/helpers';

// The key lists are shared with media-manager's Python port of these patterns (app/telemetry/redact.py SENSITIVE_KEY):
// tests/fixtures/sensitive-keys.json there is a byte-for-byte copy, read by its tests/test_telemetry_sensitive_keys.py.
const KEYS: { redact: string[]; keep: string[]; released: string[]; limit: string[] } = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/sensitive-keys.json'), 'utf8'),
);

/** The pattern as fc-shared 1.10.0 shipped it: 'otp' anywhere in a key. */
const BEFORE =
  /pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|authorization|credential|cookie|session[-_]?id|bearer|otp|passphrase|\bpin\b|\bssn\b|\bmfa\b/i;
/** The same without its 'otp' alternative: what every other alternative redacts. */
const BEFORE_WITHOUT_OTP = new RegExp(BEFORE.source.replace('|otp|', '|'), 'i');

/** What the library does with the key, by either default pattern. */
const sensitive = (key: string): boolean =>
  (redactValue({ [key]: 'hunter2' }) as Record<string, unknown>)[key] === '[REDACTED]';

const LOWER = /[a-z]/;
const LETTER = /[A-Za-z]/;
/**
 * The keys a mid-word otp may be released for, read one occurrence at a time: a letter on both sides, and no word
 * that the key's case shows starting there (Otp, Totp, Hotp; OTP, TOTP, HOTP after a lower-case letter or a digit).
 */
function everyOtpIsMidWordWithoutAHump(key: string): boolean {
  for (const found of key.matchAll(/otp/gi)) {
    const at = found.index;
    const before = key[at - 1] ?? '';
    const after = key[at + 3] ?? '';
    if (!LETTER.test(before) || !LETTER.test(after)) return false;
    const word = found[0];
    if (word === 'Otp') return false;
    if (word === 'otp' && (before === 'T' || before === 'H')) return false;
    if (word === 'OTP') {
      const lead = before === 'T' || before === 'H' ? (key[at - 2] ?? '') : before;
      if (LOWER.test(lead) || /[0-9]/.test(lead)) return false;
    }
  }
  return true;
}

describe('the otp key is anchored to a word of the key', () => {
  it('keeps footprint, footprintMm, rootPath, laptop and captopril', () => {
    const fields = { footprint: 0.42, footprintMm: 118, claim_footprint: 0.6, rootPath: '/srv', laptop: 'x1', captopril: '25mg' };
    expect(redactValue(fields)).toEqual(fields);
    expect(redactAttributes(fields)).toEqual(fields);
  });

  it('still redacts otp, otp_code, otpCode, totp, x-otp and mfa.otp', () => {
    const fields = { otp: '1', otp_code: '2', otpCode: '3', totp: '4', 'x-otp': '5', 'mfa.otp': '6' };
    const masked = Object.fromEntries(Object.keys(fields).map((key) => [key, '[REDACTED]']));
    expect(redactValue(fields)).toEqual(masked);
    expect(redactAttributes(fields)).toEqual(masked);
  });

  it('still redacts a camelCase otp word in the middle of a key', () => {
    const fields = { userOtpCode: '1', userOTPCode: '2', userTotpCode: '3', smsOtpValue: '4', hotpCounter: '5', userHotpCounter: '6' };
    const masked = Object.fromEntries(Object.keys(fields).map((key) => [key, '[REDACTED]']));
    expect(redactValue(fields)).toEqual(masked);
    expect(redactAttributes(fields)).toEqual(masked);
  });

  it('prints a footprint field of a server log line, and masks its otp fields', () => {
    const capture = captureSink();
    const log = createLogger({ service: 'media-manager', version: '1.0.0', env: {}, sink: capture.sink });
    log.info({ event: 'stage', claim_footprint: 0.6, footprintMm: 118, otpCode: '493817', userOtp: '493818' });
    log.info('timings', { footprint: 0.42, rootPath: '/srv', totp: '493819', userOtpCode: '493820', userOTPCode: '493821' });
    const [fields, text] = capture.parsed();
    expect(fields).toMatchObject({ claim_footprint: 0.6, footprint_mm: 118, otp_code: '[REDACTED]', user_otp: '[REDACTED]' });
    expect(text.msg).toBe(
      'timings {"footprint":0.42,"rootPath":"/srv","totp":"[REDACTED]","userOtpCode":"[REDACTED]","userOTPCode":"[REDACTED]"}',
    );
  });

  it.each(KEYS.redact)('redacts %s, as before', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(true);
    expect(redactAttributes({ [key]: 'hunter2' })).toEqual({ [key]: '[REDACTED]' });
  });

  it.each(KEYS.keep)('keeps %s, as before', (key) => {
    expect(BEFORE.test(key)).toBe(false);
    expect(sensitive(key)).toBe(false);
  });

  it.each(KEYS.released)('no longer redacts %s', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(false);
    expect(redactAttributes({ [key]: 'visible' })).toEqual({ [key]: 'visible' });
  });

  // Known limit: with a letter on both sides and no change of case, otp reads as the middle of a word whether the key
  // is userotpcode or footprint. No pattern can tell them apart; a key written in camelCase, or with a separator, redacts.
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
        if (BEFORE_WITHOUT_OTP.test(key) || !everyOtpIsMidWordWithoutAHump(key)) wronglyReleased.push(key);
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
    expect(DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN.flags).toBe('');
    // media-manager's SENSITIVE_KEY ends with these words as its one case-sensitive group, and its test pins them too.
    expect(DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN.source).toBe('Otp|Totp|Hotp|[a-z][TH]?OTP');
  });

  it('still composes by its source, as fc-coordinator extends it, and the camelCase pattern still applies', () => {
    const extended = new RegExp(`${DEFAULT_SENSITIVE_KEY_PATTERN.source}|(?:^|[.\\-_])dpop$`, 'i');
    const options = { sensitiveKeyPattern: extended };
    for (const key of [...KEYS.redact, 'dpop', 'x-dpop']) {
      expect(redactValue({ [key]: 'hunter2' }, options)).toEqual({ [key]: '[REDACTED]' });
      expect(redactAttributes({ [key]: 'hunter2' }, options)).toEqual({ [key]: '[REDACTED]' });
    }
    for (const key of [...KEYS.keep, ...KEYS.released]) {
      expect(redactValue({ [key]: 'visible' }, options)).toEqual({ [key]: 'visible' });
    }
  });

  it('takes a service-specific camelCase pattern, in redactValue and in the server logger', () => {
    const options = { sensitiveCamelKeyPattern: /Dpop/ };
    expect(redactValue({ userDpopKey: 'a', userOtpCode: 'b', otpCode: 'c', userdpop: 'd' }, options)).toEqual({
      userDpopKey: '[REDACTED]',
      userOtpCode: 'b',
      otpCode: '[REDACTED]',
      userdpop: 'd',
    });
    const capture = captureSink();
    const log = createLogger({ service: 'media-manager', version: '1.0.0', env: {}, sink: capture.sink, redact: options });
    log.info('proof', { userDpopKey: 'a', userOtpCode: 'b', otpCode: 'c' });
    expect(capture.parsed()[0].msg).toBe('proof {"userDpopKey":"[REDACTED]","userOtpCode":"b","otpCode":"[REDACTED]"}');
  });
});
