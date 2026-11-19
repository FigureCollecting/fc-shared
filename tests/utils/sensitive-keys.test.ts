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
const KEYS: {
  redact: string[];
  keep: string[];
  released: string[];
  otpNonSecret: string[];
  limit: string[];
  otpNonSecretSuffixes: string[];
  otpGuardWords: string[];
  otpSecretTails: string[];
  unicodePrints: string[];
  unicodeRedacts: string[];
} = JSON.parse(readFileSync(join(__dirname, '../fixtures/sensitive-keys.json'), 'utf8'));

/** The pattern as fc-shared 1.10.0 shipped it: 'otp' anywhere in a key. */
const BEFORE =
  /pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|authorization|credential|cookie|session[-_]?id|bearer|otp|passphrase|\bpin\b|\bssn\b|\bmfa\b/i;
/** The same without its 'otp' alternative: what every other alternative redacts. */
const BEFORE_WITHOUT_OTP = new RegExp(BEFORE.source.replace('|otp|', '|'), 'i');

/** What the library does with the key, by either default pattern. */
const sensitive = (key: string): boolean =>
  (redactValue({ [key]: 'hunter2' }) as Record<string, unknown>)[key] === '[REDACTED]';

/** The corpus of the differential test: fixture keys x 9 prefixes x 8 suffixes x 4 casings, and how many differ. */
const CORPUS_KEYS = 71712;
const CORPUS_DISTINCT_KEYS = 41583;

const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const LETTER = /[A-Za-z]/;
/** A word list entry's words: expiresAt is expires, then at. */
const wordsOf = (entry: string): string[] => entry.split(/(?=[A-Z])/).map((word) => word.toLowerCase());
/** What may follow an otp word for the key to print: separators, then one non-secret entry, then the end. */
const NON_SECRET_REST = KEYS.otpNonSecretSuffixes.map(
  (entry) => new RegExp(`^[^a-z0-9]*${wordsOf(entry).join('[^a-z0-9]*')}$`, 'i'),
);
/** The letters after otp when a guard word runs on from its p: footprint, footpath, potpourri. */
const GUARD_TAILS = KEYS.otpGuardWords.map((word) => word.slice(1));

/**
 * The keys the otp rule lets print, read one otp at a time (any case). Each one prints when what follows it is
 * separators and one non-secret entry, and nothing else. Otherwise it redacts when a separator or the key's edge
 * is on either side (totp and hotp count from their t or h), when its case starts a word (Otp, OtP, OTp; OTP after
 * a lower-case letter) or ends one (otp before a capital). A lower-case o with a capital inside (rootPath,
 * IoTPlatform) is no otp word. What is left (footprint, USEROTPNUMBER, MFAOTPCode) redacts unless a guard word
 * runs on from the p.
 */
function everyOtpPrintsByTheRule(key: string): boolean {
  for (const found of key.matchAll(/otp/gi)) {
    const at = found.index;
    const word = found[0];
    const before = key[at - 1] ?? '';
    const after = key[at + 3] ?? '';
    const rest = key.slice(at + 3);
    if (NON_SECRET_REST.some((words) => words.test(rest))) continue;
    const startsWord = !LETTER.test(before) || (/^[th]$/i.test(before) && !LETTER.test(key[at - 2] ?? ''));
    if (startsWord || !LETTER.test(after)) return false;
    if (word[0] === 'o' && word !== 'otp') continue;
    if (word === 'Otp' || word === 'OtP' || word === 'OTp') return false;
    if (word === 'otp' && UPPER.test(after)) return false;
    if (word === 'OTP' && LOWER.test(before)) return false;
    if (!GUARD_TAILS.some((tail) => rest.toLowerCase().startsWith(tail))) return false;
  }
  return true;
}

/** Each casing of an otp key with a tail word after the otp, totp or hotp: userotpqrcode, USEROTPQRCODE ... */
function tailKeys(tail: string): string[] {
  const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
  return ['user', 'mfa', 'sms', 'pending', 'last', 'new'].flatMap((prefix) =>
    ['otp', 'totp', 'hotp'].flatMap((core) => [
      prefix + core + tail,
      (prefix + core + tail).toUpperCase(),
      prefix + cap(core) + cap(tail),
      `${prefix}_${core}_${tail}`,
    ]),
  );
}

/** Each casing of an otp key whose word after otp is one non-secret entry: otp_expires_at, userotpexpiresat ... */
function nonSecretKeys(entry: string): string[] {
  const words = wordsOf(entry);
  const camel = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return [
    `otp_${words.join('_')}`,
    `otp${camel}`,
    `userOtp${camel}`,
    `userotp${words.join('')}`,
    `USEROTP${words.join('').toUpperCase()}`,
    `USER_TOTP_${words.join('_').toUpperCase()}`,
    `x-hotp-${words.join('-')}`,
    `smsOTP${camel}`,
    `SMSOTP${camel}`,
  ];
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

  it('redacts a single-case otp key whatever word follows otp, unless that word names no secret', () => {
    const fields = {
      userotpcode: '1', USEROTPCODE: '2', smsotpvalue: '3', MFAOTPCODE: '4', userotpauthurl: '5', userOtPCode: '6',
      userotps: '7', USEROTPNUMBER: '8', userotpbase32: '9', userotpqrcode: '10', userotpprovisioninguri: '11',
      userotpbackupcodes: '12', userotpsharedkey: '13',
    };
    const masked = Object.fromEntries(Object.keys(fields).map((key) => [key, '[REDACTED]']));
    expect(redactValue(fields)).toEqual(masked);
    expect(redactAttributes(fields)).toEqual(masked);
    expect(redactValue({ userotpattempts: 3, USEROTPEXPIRY: 'x' })).toEqual({ userotpattempts: 3, USEROTPEXPIRY: 'x' });
  });

  it.each(KEYS.otpSecretTails)('redacts otp, totp and hotp followed by %s, in four casings, as before', (tail) => {
    for (const key of tailKeys(tail)) {
      expect(BEFORE.test(key)).toBe(true);
      expect(sensitive(key)).toBe(true);
      expect(redactAttributes({ [key]: 'hunter2' })).toEqual({ [key]: '[REDACTED]' });
    }
  });

  it.each(KEYS.otpNonSecretSuffixes)('prints an otp key followed by %s alone, and redacts it with more after', (entry) => {
    for (const key of nonSecretKeys(entry)) {
      expect(BEFORE.test(key)).toBe(true);
      expect(sensitive(key)).toBe(false);
      expect(redactAttributes({ [key]: 'visible' })).toEqual({ [key]: 'visible' });
      for (const more of [`${key}s`, `${key}2`, `${key}_code`, `${key}Code`]) expect(sensitive(more)).toBe(true);
    }
  });

  // The key pattern has the i flag and no u flag, so a non-ASCII letter is a separator. With u, the long s (U+017F)
  // would read as s and the Kelvin sign (U+212A) as k.
  it.each(KEYS.unicodePrints)('prints %s: a non-ASCII letter is a separator between otp and a non-secret word', (key) => {
    expect(sensitive(key)).toBe(false);
  });

  it.each(KEYS.unicodeRedacts)('redacts %s: a non-ASCII letter does not fold to an ASCII one', (key) => {
    expect(sensitive(key)).toBe(true);
  });

  it('reads only the end of the key as its end, not a line break before it', () => {
    expect(sensitive('otp_attempts\n')).toBe(true);
    expect(sensitive('userotpattempts\n')).toBe(true);
    expect(sensitive('userOtpAttempts\n')).toBe(true);
    expect(sensitive('otp_attempts')).toBe(false);
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

  it('masks a single-case otp key in the text of a server log line, and prints one whose word names no secret', () => {
    const capture = captureSink();
    const log = createLogger({ service: 'media-manager', version: '1.0.0', env: {}, sink: capture.sink });
    log.info('header lines\nuserotpbase32: 765432\nUSEROTPNUMBER: 765433\nuserotpattempts: 3\notpExpiresAt: 9');
    expect(capture.parsed()[0].msg).toBe(
      'header lines userotpbase32: [REDACTED] USEROTPNUMBER: [REDACTED] userotpattempts: 3 otpExpiresAt: 9',
    );
    expect(capture.lines.join('\n')).not.toMatch(/76543[23]/);
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
    // A line reads its header names more than once, so the calls that miss differ by shape: an error's message is one.
    for (let call = 0; call < 3; call += 1) log.error({ err: new Error('userOtpNumber: 654322') });
    expect(capture.parsed().slice(3).map((line) => (line.err as { message: string }).message)).toEqual(
      Array(3).fill('userOtpNumber: [REDACTED]'),
    );
    expect(capture.lines.join('\n')).not.toMatch(/65432[12]/);
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

  it.each(KEYS.otpNonSecret)('no longer redacts %s: the word after its otp names no secret', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(false);
    expect(redactAttributes({ [key]: 'visible' })).toEqual({ [key]: 'visible' });
  });

  // Known limit: a lower-case o with a capital inside the otp (useroTpnumber) reads as two words, as rootPath and
  // IoTPlatform do, so it is no otp word. Any other case form of otp, totp or hotp redacts.
  it.each(KEYS.limit)('known limit: no longer redacts %s', (key) => {
    expect(BEFORE.test(key)).toBe(true);
    expect(sensitive(key)).toBe(false);
  });
});

describe('nothing but what the otp rule releases is released', () => {
  const prefixes = ['', 'x-', 'user_', 'user.', 'user', 'User', 'v2', '2', 'MFA'];
  const suffixes = ['', '_id', '-id', '.value', 'Value', 'value', '2', '_2'];
  const cases = [
    (key: string) => key,
    (key: string) => key.toUpperCase(),
    (key: string) => key.toLowerCase(),
    // Acronym style: the otp word in capitals and a capital after it (userotpcode as userOTPCode, MFAOTPCode).
    (key: string) => key.replace(/[th]?otp[a-z]?/gi, (word) => word.toUpperCase()),
  ];
  const corpus = [...KEYS.redact, ...KEYS.keep, ...KEYS.released, ...KEYS.otpNonSecret, ...KEYS.limit].flatMap((key) =>
    prefixes.flatMap((prefix) => suffixes.flatMap((suffix) => cases.map((recase) => recase(prefix + key + suffix)))),
  );

  it('over every fixture key with a prefix, a suffix and a case change', () => {
    const widened: string[] = [];
    const wronglyReleased: string[] = [];
    const wronglyRedacted: string[] = [];
    let released = 0;
    for (const key of corpus) {
      const before = BEFORE.test(key);
      const after = sensitive(key);
      if (after && !before) widened.push(key);
      const shouldPrint = before && !BEFORE_WITHOUT_OTP.test(key) && everyOtpPrintsByTheRule(key);
      if (before && !after) {
        released += 1;
        if (!shouldPrint) wronglyReleased.push(key);
      }
      if (after && shouldPrint) wronglyRedacted.push(key);
    }
    // The same two counts are pinned in media-manager's test: both repos read the same corpus.
    expect(corpus.length).toBe(CORPUS_KEYS);
    expect(new Set(corpus).size).toBe(CORPUS_DISTINCT_KEYS);
    expect(released).toBeGreaterThan(1000);
    expect(widened).toEqual([]);
    expect(wronglyReleased).toEqual([]);
    expect(wronglyRedacted).toEqual([]);
  });

  it('keeps every other alternative of the 1.10.0 pattern, and builds the otp words from the fixture lists', () => {
    const before = BEFORE.source.split('|').filter((alternative) => alternative !== 'otp');
    const after = DEFAULT_SENSITIVE_KEY_PATTERN.source.split('|');
    expect(before).toHaveLength(17);
    for (const alternative of before) expect(after).toContain(alternative);
    expect(DEFAULT_SENSITIVE_KEY_PATTERN.flags).toBe('i');
    expect(DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN.flags).toBe('');
    // media-manager's SENSITIVE_KEY holds the same pieces (its case-sensitive group last) and its test pins them too.
    const anyCase = (word: string): string => word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
    const oneOf = (entries: string[], sep: string, recase: (word: string) => string): string =>
      `(?:${entries.map((entry) => wordsOf(entry).map(recase).join(sep)).join('|')})`;
    const nonSecret = oneOf(KEYS.otpNonSecretSuffixes, '[^a-z0-9]*', (word) => word);
    const nonSecretAnyCase = oneOf(KEYS.otpNonSecretSuffixes, '[^A-Za-z0-9]*', anyCase);
    const guard = oneOf(GUARD_TAILS, '', anyCase);
    expect(DEFAULT_SENSITIVE_KEY_PATTERN.source).toContain(
      `|bearer|(?:(?:^|[^a-z])[ht]?otp|otp(?=$|[^a-z]))(?![^a-z0-9]*${nonSecret}$)|passphrase|`,
    );
    expect(DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN.source).toBe(
      '(?:Otp|[a-z]OTP|otp(?=[A-Z])|O(?:tP|Tp)' +
        `|(?:[A-Za-z]otp(?=[a-z])|[A-Z]OTP(?=[A-Za-z]))(?!${guard}))(?![^A-Za-z0-9]*${nonSecretAnyCase}$)`,
    );
  });

  it('still composes by its source, as fc-coordinator extends it, and the camelCase pattern still applies', () => {
    const extended = new RegExp(`${DEFAULT_SENSITIVE_KEY_PATTERN.source}|(?:^|[.\\-_])dpop$`, 'i');
    const options = { sensitiveKeyPattern: extended };
    for (const key of [...KEYS.redact, 'dpop', 'x-dpop']) {
      expect(redactValue({ [key]: 'hunter2' }, options)).toEqual({ [key]: '[REDACTED]' });
      expect(redactAttributes({ [key]: 'hunter2' }, options)).toEqual({ [key]: '[REDACTED]' });
    }
    for (const key of [...KEYS.keep, ...KEYS.released, ...KEYS.otpNonSecret]) {
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
