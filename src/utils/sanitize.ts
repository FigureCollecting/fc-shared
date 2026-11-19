/**
 * Secret/PII redaction for telemetry (logs + trace span attributes).
 *
 * This is the up-front scrubbing layer that runs BEFORE any telemetry leaves the
 * host — log payloads through `redactValue`, OpenTelemetry span attributes through
 * `redactAttributes`. It removes credentials and obvious PII so that the moment a
 * collector (Loki/Tempo/OTLP) is wired up, nothing sensitive is shipped.
 *
 * Deliberately dependency-free (no OpenTelemetry import): it operates on plain
 * objects and a flat attribute record, so Node services AND browser bundles can
 * use it without pulling the OTel SDK. The redaction policy lives here, in one
 * place, shared across every service; the wiring (which exporter/logger calls it)
 * stays in each service.
 *
 * Two layers of defence:
 *   1. KEY-based  — any field whose name looks like a secret (password, token,
 *      authorization, api_key, cookie, …) has its value replaced wholesale.
 *   2. VALUE-based — string values are scanned for well-known secret SHAPES
 *      (Bearer headers, JWTs, GitHub/Slack/AWS/Google keys, PEM blocks) and the
 *      matches are masked, even when the key name looked innocent.
 *
 * The value patterns are intentionally specific (known token formats) rather than
 * a broad "any long base64 string" heuristic, to keep false positives — masking
 * legitimate ids/hashes — low.
 */

/**
 * Words after an otp (totp, hotp) word that name no secret. A key whose otp
 * word is followed by separators and one of these, and nothing else, prints
 * (otp_attempts, otpExpiresAt, userotpsentat); every other otp key redacts.
 * The list is pinned by tests/fixtures/sensitive-keys.json
 * (otpNonSecretSuffixes), which media-manager's redact.py reads too.
 */
const OTP_NON_SECRET_SUFFIXES = [
  'attempts', 'count', 'enabled', 'required', 'verified', 'expires', 'expiry', 'expiresAt',
  'sent', 'sentAt', 'length', 'type', 'method', 'channel', 'status', 'lastUsed',
];
/**
 * Words that run on from the p of an otp inside a single-case word, which is
 * then no otp word: footprint, footpath, potpourri (fixture otpGuardWords).
 */
const OTP_GUARD_WORDS = ['path', 'pourri', 'print'];

/** A word in either case, letter by letter, for the case-sensitive pattern: at -> [aA][tT]. */
const anyCase = (word: string): string => word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
/** One of the entries; an entry's words (expiresAt: expires, at) may be split by `sep`. */
const oneOf = (entries: readonly string[], sep: string, recase: (word: string) => string): string =>
  `(?:${entries
    .map((entry) => entry.split(/(?=[A-Z])/).map((word) => recase(word.toLowerCase())).join(sep))
    .join('|')})`;

/**
 * Field-name patterns whose VALUE is always redacted regardless of content.
 *
 * otp, totp and hotp redact where they start the key or follow a non-letter
 * (otp, otp_code, otpCode, x-otp), or end the key or precede a non-letter
 * (userOtp, user_totp, mfa.otp); with a letter on both sides,
 * {@link DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN} reads the key's case. Either way
 * the key prints when the rest of it is a non-secret word (otp_attempts).
 */
export const DEFAULT_SENSITIVE_KEY_PATTERN = new RegExp(
  'pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|authorization' +
    '|credential|cookie|session[-_]?id|bearer|(?:(?:^|[^a-z])[ht]?otp|otp(?=$|[^a-z]))' +
    `(?![^a-z0-9]*${oneOf(OTP_NON_SECRET_SUFFIXES, '[^a-z0-9]*', (word) => word)}$)` +
    '|passphrase|\\bpin\\b|\\bssn\\b|\\bmfa\\b',
  'i',
);

/**
 * Case-SENSITIVE field-name patterns, tested as well as the pattern above, for
 * an otp with a letter on both sides. It is an otp word when the key's case
 * starts a word there (Otp, Totp, Hotp, OtP, OTp anywhere; OTP or TOTP after a
 * lower-case letter: userOtpCode, userOTPCode) or ends one (otp before a
 * capital, OTP before a capitalised word: userotpCode, MFAOTPCode), and in a
 * single-case run (userotps, USEROTPNUMBER, MFAotpcode) unless a guard word
 * runs on from its p (footprint, FOOTPRINT, footpath). A lower-case o with a
 * capital inside reads as two words (rootPath, IoTPlatform, useroTpnumber):
 * no otp word. As above, the key prints when the rest of it is a non-secret
 * word (userOtpAttempts, USEROTPSENTAT).
 */
export const DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN = new RegExp(
  '(?:Otp|Totp|Hotp|[a-z][TH]?OTP|otp(?=[A-Z])|OTP(?=[A-Z][a-z])|O(?:tP|Tp)' +
    `|(?:[A-Za-z]otp(?=[a-z])|[A-Z]OTP(?=[A-Za-z]))(?!${oneOf(OTP_GUARD_WORDS.map((word) => word.slice(1)), '', anyCase)}))` +
    `(?![^A-Za-z0-9]*${oneOf(OTP_NON_SECRET_SUFFIXES, '[^A-Za-z0-9]*', anyCase)}$)`,
);

/** Well-known secret SHAPES masked wherever they appear inside a string value. */
export const DEFAULT_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, // Authorization: Bearer <token>
  /eyJ[A-Za-z0-9._-]{10,}/g, // JWT (header.payload.signature, starts eyJ)
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / refresh / server / user tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AIza[0-9A-Za-z._-]{30,}/g, // Google API key
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, // PEM private key
];

export interface RedactOptions {
  /** Field-name matcher; defaults to {@link DEFAULT_SENSITIVE_KEY_PATTERN}. */
  sensitiveKeyPattern?: RegExp;
  /**
   * Case-sensitive field-name matcher, tested as well as sensitiveKeyPattern
   * (a custom sensitiveKeyPattern does not replace it); defaults to
   * {@link DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN}.
   */
  sensitiveCamelKeyPattern?: RegExp;
  /** Value-shape matchers; defaults to {@link DEFAULT_SECRET_VALUE_PATTERNS}. */
  secretValuePatterns?: readonly RegExp[];
  /** Replacement text for redacted values. Default '[REDACTED]'. */
  placeholder?: string;
  /** Strings longer than this are truncated (prevents log flooding). Default 8192. */
  maxStringLength?: number;
  /** Maximum object/array depth to walk. Default 12. */
  maxDepth?: number;
}

const DEFAULTS: Required<RedactOptions> = {
  sensitiveKeyPattern: DEFAULT_SENSITIVE_KEY_PATTERN,
  sensitiveCamelKeyPattern: DEFAULT_SENSITIVE_CAMEL_KEY_PATTERN,
  secretValuePatterns: DEFAULT_SECRET_VALUE_PATTERNS,
  placeholder: '[REDACTED]',
  maxStringLength: 8192,
  maxDepth: 12,
};

function isSensitiveKey(key: string, opts: Required<RedactOptions>): boolean {
  // Reset lastIndex so a stateful /g pattern can't desync across calls.
  opts.sensitiveKeyPattern.lastIndex = 0;
  if (opts.sensitiveKeyPattern.test(key)) return true;
  opts.sensitiveCamelKeyPattern.lastIndex = 0;
  return opts.sensitiveCamelKeyPattern.test(key);
}

/**
 * Mask well-known secret shapes inside a single string, then truncate. Pure: the
 * input is never mutated. Returns the string unchanged when nothing matches and
 * it is within the length cap.
 */
export function redactString(value: string, options: RedactOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  let out = value;
  for (const pattern of opts.secretValuePatterns) {
    // Clone the regex per use so the shared module-level patterns stay stateless.
    out = out.replace(new RegExp(pattern.source, pattern.flags), opts.placeholder);
  }
  if (out.length > opts.maxStringLength) {
    out = out.slice(0, opts.maxStringLength) + '…[truncated]';
  }
  return out;
}

/**
 * Produce a redacted, JSON-safe deep copy of any value for logging. Sensitive
 * keys have their value replaced; string values are scanned for secret shapes;
 * long strings are truncated. Circular references and over-deep structures are
 * collapsed to markers rather than thrown on. The original is never mutated.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const opts = { ...DEFAULTS, ...options };
  return walk(value, opts, 0, new WeakSet<object>());
}

function walk(
  value: unknown,
  opts: Required<RedactOptions>,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return redactString(value as string, opts);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return `${(value as bigint).toString()}n`;
  if (t === 'function' || t === 'symbol') return `[${t}]`;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message ?? '', opts),
      stack: value.stack ? redactString(value.stack, opts) : undefined,
    };
  }
  // Binary blobs: don't serialise, don't risk leaking raw bytes.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]';

  if (depth >= opts.maxDepth) return '[truncated:max-depth]';

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = value.map((item) => walk(item, opts, depth + 1, seen));
    seen.delete(value);
    return out;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = isSensitiveKey(key, opts)
        ? opts.placeholder
        : walk(obj[key], opts, depth + 1, seen);
    }
    seen.delete(obj);
    return out;
  }

  return String(value);
}

/**
 * OpenTelemetry attribute value: the spec allows a primitive or a homogeneous
 * array of primitives. Typed structurally so this module needs no OTel import.
 */
export type AttributeValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean | null | undefined>
  | null
  | undefined;

/**
 * Redact a flat span-attribute record before it is exported. Attribute keys are
 * dotted (e.g. `http.request.header.authorization`) so the key matcher catches
 * the sensitive segment; string values are additionally scanned for secret
 * shapes. Returns a NEW record; the input is not mutated.
 *
 * Wrap your real SpanExporter so this runs on each span's attributes just before
 * export — the redaction policy stays here, the wiring stays in the service.
 */
export function redactAttributes(
  attributes: Record<string, AttributeValue>,
  options: RedactOptions = {},
): Record<string, AttributeValue> {
  const opts = { ...DEFAULTS, ...options };
  const out: Record<string, AttributeValue> = {};
  for (const key of Object.keys(attributes)) {
    const val = attributes[key];
    if (isSensitiveKey(key, opts)) {
      out[key] = opts.placeholder;
      continue;
    }
    if (typeof val === 'string') {
      out[key] = redactString(val, opts);
    } else if (Array.isArray(val)) {
      out[key] = val.map((item) => (typeof item === 'string' ? redactString(item, opts) : item));
    } else {
      out[key] = val;
    }
  }
  return out;
}
