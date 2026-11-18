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

/** The corpus of the differential test: every fixture key x 9 prefixes x 8 suffixes x 4 casings, and how many differ. */
const CORPUS_KEYS = 54432;
const CORPUS_DISTINCT_KEYS = 29692;

const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const LETTER = /[A-Za-z]/;
/** The words that name a secret straight after otp, in any case and with no separator (userotpcode, USEROTPSEED). */
const SECRET_SUFFIXES = [
  'auth', 'code', 'key', 'secret', 'seed', 'token', 'value', 'counter',
  'uri', 'url', 'pin', 'digits', 'hash', 'b32', 'raw', 'recovery',
];
/**
 * The keys a mid-word otp may be released for, read one occurrence at a time: a letter on both sides; no word that
 * the key's case shows starting there (Otp, Totp, Hotp; OTP, TOTP, HOTP after a lower-case letter or a digit); no
 * word that the key's case shows ending there (otp before a capital; OTP before a capitalised word); and no secret
 * suffix straight after it.
 */
function everyOtpIsMidWordWithNoWordEdge(key: string): boolean {
  for (const found of key.matchAll(/otp/gi)) {
    const at = found.index;
    const before = key[at - 1] ?? '';
    const after = key[at + 3] ?? '';
    if (!LETTER.test(before) || !LETTER.test(after)) return false;
    const word = found[0];
    if (word === 'Otp') return false;
    if (word === 'otp' && (before === 'T' || before === 'H')) return false;
    if (word === 'otp' && UPPER.test(after)) return false;
    if (word === 'OTP') {
      const lead = before === 'T' || before === 'H' ? (key[at - 2] ?? '') : before;
      if (LOWER.test(lead) || /[0-9]/.test(lead)) return false;
      if (UPPER.test(after) && LOWER.test(key[at + 4] ?? '')) return false;
    }
    const rest = key.slice(at + 3).toLowerCase();
    if (SECRET_SUFFIXES.some((suffix) => rest.startsWith(suffix))) return false;
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

  it('still redacts a key whose case shows where the otp word ends', () => {
    const fields = { MFAOTPCode: '1', SMSOTPCode: '2', MFATOTPSeed: '3', userotpCode: '4', smsotpValue: '5', MFAOTPNumber: '6', userotpNumber: '7' };
    const masked = Object.fromEntries(Object.keys(fields).map((key) => [key, '[REDACTED]']));
    expect(redactValue(fields)).toEqual(masked);
    expect(redactAttributes(fields)).toEqual(masked);
  });

  it('still redacts a single-case key that names a secret straight after otp', () => {
    const fields = { userotpcode: '1', USEROTPCODE: '2', smsotpvalue: '3', MFAOTPCODE: '4', userotpauthurl: '5', userOtPCode: '6' };
    const masked = Object.fromEntries(Object.keys(fields).map((key) => [key, '[REDACTED]']));
    expect(redactValue(fields)).toEqual(masked);
    expect(redactAttributes(fields)).toEqual(masked);
  });

  it.each(SECRET_SUFFIXES)('redacts otp%s in lower and in upper case, as before', (suffix) => {
    for (const key of [`userotp${suffix}`, `USEROTP${suffix.toUpperCase()}`, `smstotp${suffix}s`]) {
      expect(BEFORE.test(key)).toBe(true);
      expect(sensitive(key)).toBe(true);
      expect(redactAttributes({ [key]: 'hunter2' })).toEqual({ [key]: '[REDACTED]' });
    }
  });

  it('masks a camelCase or acronym otp key in the text of a server log line', () => {
    const capture = captureSink();
    const log = createLogger({ service: 'media-manager', version: '1.0.0', env: {}, sink: capture.sink });
    log.info('smsOtpValue: 123456');
    log.info('MFAOTPCode: 123457');
    // Only the case-sensitive pattern knows these three.
    log.info('header lines\nuserOtpNumber: 654321\nMFAOTPNumber: 654322\nuserotpNumber: 654323\nfootprint: 0.42');
    log.info({ raw: ['userOtpNumber', '654324', 'rootPath', '/srv'], form: 'userOtpNumber=654325&footprint=1' });
    const out = capture.parsed();
    expect(out[0].msg).toBe('smsOtpValue: [REDACTED]');
    expect(out[1].msg).toBe('MFAOTPCode: [REDACTED]');
    expect(out[2].msg).toBe(
      'header lines userOtpNumber: [REDACTED] MFAOTPNumber: [REDACTED] userotpNumber: [REDACTED] footprint: 0.42',
    );
    expect(out[3]).toMatchObject({
      raw: '["userOtpNumber","[REDACTED]","rootPath","/srv"]',
      form: 'userOtpNumber=[REDACTED]&footprint=1',
    });
    expect(capture.lines.join('\n')).not.toMatch(/12345[67]|65432[1-5]/);
  });

  it('gives the same answer on every call when the camelCase pattern is global (/g)', () => {
    // A /g pattern keeps lastIndex after a match: tested again without a reset, it misses every second time.
    const options = { sensitiveCamelKeyPattern: new RegExp(DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN.source, 'g') };
    const capture = captureSink();
    const log = createLogger({ service: 'media-manager', version: '1.0.0', env: {}, sink: capture.sink, redact: options });
    for (let call = 0; call < 3; call += 1) {
      expect(redactValue({ userOtpNumber: 'hunter2' }, options)).toEqual({ userOtpNumber: '[REDACTED]' });
      expect(redactAttributes({ userOtpNumber: 'hunter2' }, options)).toEqual({ userOtpNumber: '[REDACTED]' });
      log.info('userOtpNumber: 654321');
    }
    expect(capture.parsed().map((line) => line.msg)).toEqual(Array(3).fill('userOtpNumber: [REDACTED]'));
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

  // Known limit: otp with a letter on both sides, no secret suffix straight after it, and no word edge shown by case.
  // That is a single-case key (userotpattempts, USEROTPNUMBER), an odd case mix (userOtPAttempts) and a run of
  // acronyms (mfaSMSOTPID). A key written in camelCase, or with a separator, redacts.
  it.each(KEYS.limit)('known limit: no longer redacts %s', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(false);
  });
});

describe('nothing but a mid-word otp is released', () => {
  const prefixes = ['', 'x-', 'user_', 'user.', 'user', 'User', 'v2', '2', 'MFA'];
  const suffixes = ['', '_id', '-id', '.value', 'Value', 'value', '2', '_2'];
  const cases = [
    (key: string) => key,
    (key: string) => key.toUpperCase(),
    (key: string) => key.toLowerCase(),
    // Acronym style: the otp word in capitals and a capital after it (userotpcode as userOTPCode, MFAOTPCode).
    (key: string) => key.replace(/[th]?otp[a-z]?/gi, (word) => word.toUpperCase()),
  ];
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
        if (BEFORE_WITHOUT_OTP.test(key) || !everyOtpIsMidWordWithNoWordEdge(key)) wronglyReleased.push(key);
      }
    }
    // The same two counts are pinned in media-manager's test: both repos read the same corpus.
    expect(corpus.length).toBe(CORPUS_KEYS);
    expect(new Set(corpus).size).toBe(CORPUS_DISTINCT_KEYS);
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
    expect(DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN.source).toBe('Otp|Totp|Hotp|[a-z][TH]?OTP|otp(?=[A-Z])|OTP(?=[A-Z][a-z])');
    // The secret suffixes are one case-insensitive alternative, in media-manager's SENSITIVE_KEY too.
    expect(DEFAULT_SENSITIVE_KEY_PATTERN.source).toContain(`|otp(?:${SECRET_SUFFIXES.join('|')})|`);
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
    expect(redactValue({ userDpopKey: 'a', userOtpNumber: 'b', otpCode: 'c', userdpop: 'd' }, options)).toEqual({
      userDpopKey: '[REDACTED]',
      userOtpNumber: 'b',
      otpCode: '[REDACTED]',
      userdpop: 'd',
    });
    const capture = captureSink();
    const log = createLogger({ service: 'media-manager', version: '1.0.0', env: {}, sink: capture.sink, redact: options });
    log.info('proof', { userDpopKey: 'a', userOtpNumber: 'b', otpCode: 'c' });
    log.info('userDpopKey: hunter2');
    log.info('userOtpNumber: visible');
    expect(capture.parsed().map((line) => line.msg)).toEqual([
      'proof {"userDpopKey":"[REDACTED]","userOtpNumber":"b","otpCode":"[REDACTED]"}',
      'userDpopKey: [REDACTED]',
      'userOtpNumber: visible',
    ]);
  });
});
