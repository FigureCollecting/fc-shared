/**
 * NODE-ONLY structured logger in the estate's one log shape (lg-logging plan,
 * log_shape). One JSON object per stdout line, never multi-line:
 *
 *   time level service version event msg call code duration_ms peer
 *   trace_id span_id job err queue_ms, then the event's own fields
 *
 * RESERVED keys are typed and always in that order. trace_id/span_id come only
 * from the ACTIVE span and are absent (never zeroed) without one. Every other
 * key is normalised to lowercase snake_case with a flat scalar value: strings
 * are redacted by fc-shared's policy and made log-injection safe
 * (sanitizeLogValue: no newlines, 1000-char cap); objects become one-line JSON.
 *
 * Every value the logger prints (msg and its parts, err.type and
 * err.message, each extra field and object key, the reserved call, code,
 * peer, job and event, bridged and printf console arguments, and an Error's
 * message wherever it appears, its stack included) goes through one policy: a
 * URL loses its query, fragment and userinfo; a value under a URL-named key
 * (url, href, path ...) is cut at its first ? or #; a sensitive header line,
 * header-list entry or form-encoded value is masked; a string that is a whole
 * JSON object or array is key-redacted; objects are key-redacted in their JSON
 * form, a key that names a secret masking its value even when printing
 * changes the key, and a node HTTP message or stream prints as a short summary
 * (see printValue).
 *
 * The surface is pino-compatible (level, trace..fatal, silent, child), so it can
 * be handed to Fastify as `loggerInstance`. It is promoted from fc-coordinator's
 * src/platform/logger.ts, with the keys renamed to the plan's shape
 * (name -> service, traceId -> trace_id); fc-coordinator keeps its own logger
 * until it migrates (lg-logging U8).
 *
 * FC_LOG_FORMAT=text is the escape hatch: the same fields as one human line.
 * installConsoleBridge() turns stray console.* calls into one app.console line
 * each, so a service's legacy console output joins the shape without edits.
 */
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { Stream } from 'node:stream';
import { formatWithOptions } from 'node:util';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { sanitizeLogValue } from '../utils/logger';
import {
  DEFAULT_SENSITIVE_KEY_PATTERN,
  redactString,
  redactValue,
  type RedactOptions,
} from '../utils/sanitize';
import { roundMs } from './fields';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LevelSetting = LogLevel | 'silent';
export type LogFormat = 'json' | 'text';
export type Env = Record<string, string | undefined>;

/** Reserved keys, in the order every line writes them. */
export const RESERVED_LOG_KEYS = [
  'time', 'level', 'service', 'version', 'event', 'msg', 'call', 'code', 'duration_ms',
  'peer', 'trace_id', 'span_id', 'job', 'err', 'queue_ms',
] as const;

/** Keys the logger owns; a caller-supplied value for one of them is dropped. */
const OWNED = new Set(['time', 'level', 'service', 'version', 'msg', 'trace_id', 'span_id']);
/** Reserved keys a caller sets through the merge object; each is typed on the way out. */
const CALLER_RESERVED = new Set(['event', 'call', 'code', 'duration_ms', 'peer', 'job', 'err', 'queue_ms']);

const SEVERITY: Record<LevelSetting, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/**
 * Walk depth for an object-valued field. Deliberately shallow (from
 * fc-coordinator): one framework object otherwise serialises a socket graph
 * into a 40 KB line before the 1000-char cap ever applies.
 */
const MAX_FIELD_DEPTH = 4;

export interface ServiceIdentity {
  service: string;
  version: string;
}

export interface LoggerOptions {
  /** Default: OTEL_SERVICE_NAME, else 'unknown_service'. */
  service?: string;
  /** Default: SERVICE_VERSION, else npm_package_version, else 'unknown'. */
  version?: string;
  /** Minimum level. Default: LOG_LEVEL from env, else 'info'. */
  level?: LevelSetting;
  /** Default: FC_LOG_FORMAT from env ('text'), else 'json'. */
  format?: LogFormat;
  /** Where a finished line goes. Default: one line on stdout. */
  sink?: (line: string) => void;
  /** Environment to read. Default: process.env. */
  env?: Env;
  /** Fields merged into every line. */
  bindings?: Record<string, unknown>;
  /** Service-specific redaction (e.g. fc-coordinator's DPoP key pattern). */
  redact?: RedactOptions;
}

export interface Logger {
  // A string, not LevelSetting, so the logger is assignable to Fastify's
  // FastifyBaseLogger (pino's LevelWithSilentOrString).
  readonly level: string;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  silent(...args: unknown[]): void;
  /**
   * An empty, unknown or non-string level keeps this logger's level (Fastify 5
   * passes level ''); pino keeps it for an empty level and throws for an unknown one.
   */
  child(bindings: Record<string, unknown>, options?: { level?: LevelSetting }): Logger;
  isLevelEnabled(level: string): boolean;
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** service and version for both the log lines and the trace resource. */
export function resolveServiceIdentity(env: Env = process.env, overrides: Partial<ServiceIdentity> = {}): ServiceIdentity {
  return {
    service: firstNonBlank(overrides.service, env['OTEL_SERVICE_NAME']) ?? 'unknown_service',
    version: firstNonBlank(overrides.version, env['SERVICE_VERSION'], env['npm_package_version']) ?? 'unknown',
  };
}

function parseLevel(value: unknown): LevelSetting | undefined {
  // A string only (an untyped caller may pass pino's numbers); an own key only: 'constructor' or 'toString' is not a level.
  const normalised = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  return normalised !== undefined && Object.hasOwn(SEVERITY, normalised) ? (normalised as LevelSetting) : undefined;
}

/**
 * `itemId` -> `item_id`, `HTTP-Status` -> `http_status`; never empty, never leading digit. Linear in the key's
 * length (a key can be as long as a request body): no rule rescans a run of capitals.
 */
export function toSnakeCase(key: string): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (snake === '') return 'field';
  return /^[0-9]/.test(snake) ? `f_${snake}` : snake;
}

interface Core {
  identity: ServiceIdentity;
  job: string | undefined;
  format: LogFormat;
  sink: (line: string) => void;
  redact: RedactOptions;
}

type Scalar = string | number | boolean | null;

/**
 * Query and form keys that hold a secret under a plain name: a URL signature
 * (sig, signature, X-Amz-Signature) and a PKCE code_verifier, each a word of
 * the snake_case key (urlSig, codeVerifier), whatever key pattern the service
 * gives.
 */
const QUERY_SECRET_KEY = /(?:^|_)(?:sig|signature|code_verifier)(?:_|$)/;
/** In a form an OAuth code too, as a word of the key (code, device_code). */
const FORM_SECRET_KEY = /(?:^|_)code(?:_|$)/;
/**
 * An object key that holds an OAuth code (RFC 6749 code, RFC 8628 device_code and user_code, auth_code), as the
 * snake_case key. Only these: code as a word of a key is also statusCode, jan_code and error_code.
 */
const OAUTH_CODE_KEY = /^(?:auth_|authorization_|device_|user_)?code$/;
/** A key that can hold one of those words: only it is snake-cased (snake-casing every key doubled an 8 KB form's cost). */
const SECRET_WORD_HINT = /sig|code/i;

function isSensitive(key: string, redact: RedactOptions, form = false): boolean {
  const pattern = redact.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;
  pattern.lastIndex = 0;
  if (pattern.test(key)) return true;
  if (!SECRET_WORD_HINT.test(key)) return false;
  const snake = toSnakeCase(key);
  return QUERY_SECRET_KEY.test(snake) || (form && FORM_SECRET_KEY.test(snake));
}

/**
 * A value under an OAuth code key (OAUTH_CODE_KEY) as a parsed query or body holds one: any string (a reset code
 * '493817' reads as an error code 'ENOENT' does), or an array (a repeated query key). A number, a boolean, null and
 * an object print as any value does (a gRPC status's code); the log shape's own code field is never read here.
 */
function isSecretCode(key: string, value: unknown): boolean {
  if (!OAUTH_CODE_KEY.test(toSnakeCase(key))) return false;
  if (typeof value === 'string') return true;
  try {
    return Array.isArray(value);
  } catch {
    // A revoked Proxy: it prints as '[unserializable]', as any value the logger cannot read.
    return false;
  }
}

/** A key whose value is masked, unread: a sensitive key, or an OAuth code key holding a code. */
function masks(key: string, value: unknown, redact: RedactOptions): boolean {
  return isSensitive(key, redact) || isSecretCode(key, value);
}

function placeholder(redact: RedactOptions): string {
  return redact.placeholder ?? '[REDACTED]';
}

function safeString(value: string, redact: RedactOptions): string {
  return sanitizeLogValue(redactText(value, redact));
}

/** Flatten one extra field to a scalar the schema accepts. */
function flatValue(key: string, value: unknown, redact: RedactOptions): Scalar {
  if (value === null) return null;
  if (isSensitive(key, redact)) return placeholder(redact);
  switch (typeof value) {
    case 'string':
    case 'object':
      return sanitizeLogValue(printValue(value, redact, 0, isUrlKey(key)));
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    default:
      return `[${typeof value}]`;
  }
}

/** util.inspect's hook: an object that defines it has chosen how it is shown. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
/** Entries kept per array or object; past it, MAX_ENTRIES - 1 and a count of the rest. */
const MAX_ENTRIES = 100;
const TRUNCATED = '[truncated:max-depth]';
/**
 * Entries read per printed value, all levels and the JSON strings in it
 * together (Budget); past it, an object, array or JSON string prints a marker,
 * unread. It bounds the work for a graph or JSON string that is shared by
 * reference (width ^ depth). A printed value is cut at 1000 characters and
 * every entry prints at least two, so in a value with no JSON string nested in
 * it the marker never shows in what is kept; a container's entries are counted
 * before they print, so under several levels of nested JSON strings it can.
 */
const MAX_TOTAL_ENTRIES = 1000;
const TRUNCATED_ENTRIES = '[truncated:max-entries]';
/** What a value (or a whole call) the logger cannot read prints as. */
const UNSERIALIZABLE = '[unserializable]';

/**
 * A URL anywhere in text: a scheme (at most 32 characters, so a long word
 * costs linear time) or none ('//cdn.example/a'), optional userinfo (up to the
 * last '@' before the path), host and path, then a query or fragment that runs
 * to the next whitespace. A quote does not end the query: encodeURIComponent
 * leaves an apostrophe raw.
 */
const URL_IN_TEXT = /((?:[a-z][a-z0-9+.-]{0,31}:)?\/\/)(?:[^\s/?#]*@)?([^\s?#]*)([?#]\S*)?/gi;
/**
 * An HTTP method and a request target carrying a query or fragment, after a
 * space ('GET /items?sig=1 HTTP/1.1') or a colon (Fastify's 'Route
 * GET:/x?sig=1 not found'). After a colon the target holds no colon, so a run
 * of 'GET:GET:...' costs linear time (each try stops at the next colon).
 */
const REQUEST_TARGET = /\b(GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH)( +[^\s?#]*|:[^\s?#:]*)([?#]\S*)/g;
/** What a stripped query keeps of its end: the quote, bracket or punctuation that closes the URL. */
const CLOSERS = '\'"`)]}>.,;:!';
/** A value's first token up to a ? or # (no whitespace before it). */
const LEADING_TOKEN = /^([^\s?#]*)[?#]/;
/** A token that reads as a URL or a path: a scheme, any slash or backslash, or a dotted host and port. */
const URL_SHAPED = /^[a-z][a-z0-9+.-]{0,31}:|[\\/]|^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i;
/** A query or fragment that starts with a key=value pair ('?token=1', '#access_token=1'). */
const QUERY_PAIRS = /^[?#][^\s=]*=/;
/** A header line, at the start of the text or of a line: `Name: value`. */
const HEADER_LINE = /(^|[\r\n])([!#$%&'*+.^_`|~0-9A-Za-z-]+)([ \t]*:[ \t]*)[^\r\n]*/g;
/** A header name (an RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Words that, as one part of a key (imageUrl, redirect_uri, links), mark its value as a URL. */
const URL_KEY_WORDS = new Set([
  'url', 'urls', 'uri', 'uris', 'href', 'hrefs', 'link', 'links', 'path', 'paths', 'target', 'endpoint',
  'endpoints', 'location', 'referer', 'referrer', 'redirect', 'redirects',
]);

function isUrlKey(key: string): boolean {
  return toSnakeCase(key).split('_').some((word) => URL_KEY_WORDS.has(word));
}

/** The closing characters that end a query: they belong to the text around the URL. A query starts with ? or #, never one. */
function closers(query: string): string {
  let start = query.length;
  while (CLOSERS.includes(query[start - 1])) start -= 1;
  return query.slice(start);
}

function stripQuery(_match: string, before: string, kept: string, query: string | undefined): string {
  return before + kept + (query === undefined ? '' : closers(query));
}

/**
 * Text without the query, fragment and userinfo of any URL in it (lg-logging
 * plan-v2: the logger strips query strings). A value whose first token reads
 * as a URL or path (with or without a scheme), or is followed by a query of
 * key=value pairs (a single-label, IPv6 or internationalised host), is cut at
 * its first ? or #, whatever follows; so a bare query of key=value pairs
 * prints empty. A request target after an HTTP method and every `scheme://`
 * or `//` URL lose their query up to the next whitespace. The rest of the text
 * is kept as written.
 */
function stripUrls(text: string): string {
  const trimmed = text.trim();
  const leading = LEADING_TOKEN.exec(trimmed);
  const kept =
    leading !== null && (URL_SHAPED.test(leading[1]) || QUERY_PAIRS.test(trimmed.slice(leading[1].length)))
      ? leading[1]
      : text;
  return kept.replace(REQUEST_TARGET, stripQuery).replace(URL_IN_TEXT, stripQuery);
}

/** Text with the value of each sensitive header line (`Cookie: ...`, `Authorization: Basic ...`) masked. */
function maskHeaderLines(text: string, redact: RedactOptions): string {
  return text.replace(HEADER_LINE, (line: string, start: string, name: string, colon: string) =>
    isSensitive(name, redact) ? `${start}${name}${colon}${placeholder(redact)}` : line,
  );
}

/** A run of %XX escapes. */
const ESCAPES = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * A form key as a server reads it (WHATWG form decoding): each '+' read as a
 * space, then each run of %XX escapes decoded as UTF-8, a byte that is not
 * UTF-8 read as U+FFFD, a '%' that starts no escape kept. Never an exception,
 * so a key that does not decode costs what one that does costs
 * (decodeURIComponent throws for each).
 */
function formKey(raw: string): string {
  return raw
    .replaceAll('+', ' ')
    .replace(ESCAPES, (run) => Buffer.from(run.replaceAll('%', ''), 'hex').toString('utf8'));
}

/**
 * A value that is wholly a form-encoded list (key=value&key=value with no
 * whitespace, as axios sends a URLSearchParams body) with the value of each
 * sensitive key masked (the form keys of isSensitive included); any other
 * text, or a form with nothing to mask, is returned as it came.
 */
function maskForm(text: string, redact: RedactOptions): string {
  const form = text.trim();
  if (/\s/.test(form)) return text;
  const masked = form
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      return equals > 0 && isSensitive(formKey(pair.slice(0, equals)), redact, true)
        ? `${pair.slice(0, equals + 1)}${placeholder(redact)}`
        : pair;
    })
    .join('&');
  return masked === form ? text : masked;
}

/** Text that is not a JSON document as the logger prints it; also every object key. */
function plainText(text: string, redact: RedactOptions): string {
  return stripUrls(maskForm(maskHeaderLines(redactString(text, redact), redact), redact));
}

/** The text, trimmed, when it may be a whole JSON object or array (it starts with '{' or '['). */
function jsonCandidate(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? trimmed : undefined;
}

/** The parsed value of a candidate that is a JSON object or array. */
function jsonDocument(candidate: string): object | undefined {
  try {
    return JSON.parse(candidate) as object;
  } catch {
    return undefined;
  }
}

/** A string as printed, and the entries its printing read (a JSON string's own). */
interface Printed {
  text: string;
  cost: number;
}

/**
 * What one printed value may still read: entries left, all levels together
 * and the JSON strings in it included, and the strings it has printed, per
 * nesting and URL slot. A string seen again is printed from that record, at
 * its cost again, so sharing one JSON string many times reads it once and
 * prints exactly what reading it each time would (MAX_TOTAL_ENTRIES).
 */
interface Budget {
  left: number;
  printed: Array<Map<string, Printed>>;
}

function freshBudget(): Budget {
  return { left: MAX_TOTAL_ENTRIES, printed: [] };
}

/**
 * A string as the logger prints it. A whole JSON object or array is printed as
 * an object is and re-emitted compact, up to four strings deep (a fifth prints
 * the depth marker, never its text), its entries counted in the budget of the
 * value around it; past that budget it prints the entries marker, unparsed.
 * Any other text goes through plainText; a URL value (inUrl) is first cut at
 * its first ? or #, so no rule reads its query.
 */
function redactText(text: string, redact: RedactOptions, nesting = 0, inUrl = false, budget = freshBudget()): string {
  const candidate = jsonCandidate(text);
  if (candidate !== undefined && budget.left < 0) return TRUNCATED_ENTRIES;
  const slot = (budget.printed[nesting * 2 + Number(inUrl)] ??= new Map<string, Printed>());
  const known = slot.get(text);
  // Reused only when the entries it read are still left; past the budget, only text that read none.
  if (known !== undefined && known.cost <= Math.max(budget.left, 0)) {
    budget.left -= known.cost;
    return known.text;
  }
  const before = budget.left;
  const doc = candidate === undefined ? undefined : jsonDocument(candidate);
  let out: string;
  if (doc === undefined) {
    // A URL value's query is never printed, so it is cut before any rule reads it.
    out = inUrl ? plainText(text.split(/[?#]/, 1)[0], redact).trim() : plainText(text, redact);
  } else {
    out = nesting < MAX_FIELD_DEPTH ? JSON.stringify(printValue(doc, redact, nesting + 1, inUrl, budget)) : TRUNCATED;
  }
  // A printing the budget cut short read more than was left, so it is never reused: left stays below 0.
  slot.set(text, { text: out, cost: before - budget.left });
  return out;
}

/** A stack frame line, as V8 writes one ('    at fn (file.js:1:2)'). */
const STACK_FRAME = /^\s+at /;
/** A node error code, as node writes one in its own errors' stack header ('RangeError [ERR_OUT_OF_RANGE]: ...'). */
const NODE_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

/** An Error's name as V8 reads it for a header: 'Error' when it has none. */
function errorLabel(name: unknown): string {
  return name === undefined ? 'Error' : String(name);
}

/** The header V8 writes for a name and a message: 'name: message', the name alone for no message, the message alone for no name. */
function stackHeader(name: string, message: string): string {
  if (name === '') return message;
  return message === '' ? name : `${name}: ${message}`;
}

/**
 * An Error as the logger prints it: {name, message, stack}, never its own
 * properties. The stack's header repeats the message, so it is written again
 * from the name and the printed message, as V8 writes it ('name: message'),
 * or as node writes its own errors ('name [CODE]: message') when the stack
 * starts with that header. The frames are kept: the lines after that header
 * when they are all frames, so a message's own frame-shaped lines are printed
 * as the message; otherwise (the message changed after the stack was written,
 * a custom stack) the frames after the last line that is not one.
 */
function errorShape(
  error: Error,
  redact: RedactOptions,
  nesting: number,
  inUrl: boolean,
  budget: Budget,
): { name: string; message: unknown; stack: unknown } {
  const { name, message, stack } = error;
  if (typeof stack !== 'string') return { name, message, stack };
  const text = typeof message === 'string' ? message : '';
  const printed = redactText(text, redact, nesting, inUrl, budget);
  const label = errorLabel(name);
  const code = (error as { code?: unknown }).code;
  const coded = typeof code === 'string' && NODE_ERROR_CODE.test(code) ? `${label} [${code}]` : label;
  const lines = stack.split('\n');
  let frames = lines.length;
  while (frames > 0 && STACK_FRAME.test(lines[frames - 1])) frames -= 1;
  let prefix = label;
  let start = frames;
  for (const candidate of [label, coded]) {
    const header = stackHeader(candidate, text);
    const size = header.split('\n').length;
    if (size >= frames && `${stack}\n`.startsWith(`${header}\n`)) {
      prefix = candidate;
      start = size;
    }
  }
  return { name, message, stack: [stackHeader(prefix, printed), ...lines.slice(start)].join('\n') };
}

function isBinary(value: unknown): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/** `[ClassName]`, or `[object]` when there is no class name. */
function classLabel(value: object): string {
  const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return `[${typeof name === 'string' && name !== '' ? name : 'object'}]`;
}

/** A node stream, or the one a framework wrapper holds in raw (Fastify's Request and Reply, beside its parsed query). */
function streamOf(value: unknown): Stream | undefined {
  if (value instanceof Stream) return value;
  const raw = (value as { raw?: unknown } | null | undefined)?.raw;
  return raw instanceof Stream ? raw : undefined;
}

/**
 * A node stream as the logger prints it, never its internals (a
 * ClientRequest's _header holds the request line and every header, an
 * IncomingMessage's rawHeaders every header): an incoming request as {method,
 * url}, an incoming response as {statusCode}, an outgoing request as {method,
 * host, path}, a server response as {statusCode}; any other stream (a socket,
 * follow-redirects' request) as [ClassName]. url and path are URL values.
 */
function streamSummary(stream: Stream): unknown {
  if (stream instanceof IncomingMessage) {
    return stream.method ? { method: stream.method, url: stream.url } : { statusCode: stream.statusCode };
  }
  if (stream instanceof ClientRequest) return { method: stream.method, host: stream.host, path: stream.path };
  if (stream instanceof ServerResponse) return { statusCode: stream.statusCode };
  return classLabel(stream);
}

/** The array or object itself, or past MAX_ENTRIES its first MAX_ENTRIES - 1 entries and a count of the rest. */
function bounded(value: object): object {
  if (Array.isArray(value)) {
    if (value.length <= MAX_ENTRIES) return value;
    return [...value.slice(0, MAX_ENTRIES - 1), `[truncated:${value.length - MAX_ENTRIES + 1} more]`];
  }
  const keys = Object.keys(value);
  if (keys.length <= MAX_ENTRIES) return value;
  const kept: Record<string, unknown> = {};
  for (const key of keys.slice(0, MAX_ENTRIES - 1)) kept[key] = (value as Record<string, unknown>)[key];
  kept['[truncated]'] = `${keys.length - MAX_ENTRIES + 1} more`;
  return kept;
}

/**
 * A raw header list (node's rawHeaders: name, value, name, value ...) with the
 * value after each sensitive name masked. An array of odd length, or with an
 * even entry that is not a header name, is not a header list and is returned.
 */
function headerList(list: unknown[], redact: RedactOptions): unknown[] {
  const names = list.length % 2 === 0 && list.every((item, index) => index % 2 === 1 || HEADER_NAME.test(String(item)));
  if (!names) return list;
  return list.map((item, index) =>
    index % 2 === 1 && isSensitive(String(list[index - 1]), redact) ? placeholder(redact) : item,
  );
}

/**
 * The object with its keys printed as text is (a URL key loses its query); the
 * object itself when no key changes. A key that names a secret before it is
 * printed ('/login?password') has its value masked here, unread: the printed
 * key may no longer say so.
 */
function rekeyed(value: object, redact: RedactOptions): object {
  const keys = Object.keys(value);
  const printed = keys.map((key) => plainText(key, redact));
  if (printed.every((key, index) => key === keys[index])) return value;
  const out: Record<string, unknown> = {};
  keys.forEach((key, index) => {
    const entry = (value as Record<string, unknown>)[key];
    out[printed[index]] = masks(key, entry, redact) ? placeholder(redact) : entry;
  });
  return out;
}

/**
 * The JSON.stringify replacer behind printValue. JSON.stringify has already
 * applied toJSON (so AxiosHeaders, a URL or a Date arrive as their JSON form);
 * the original is read back from the holder.
 *   - a string: redactText, as a URL value when its key, or a key above it, is
 *     URL-named (url, href, links ...); a bigint: '10n'; a function or
 *     symbol: '[function]';
 *   - an Error: errorShape, never its own properties (an AxiosError's
 *     config and response), whatever its toJSON says;
 *   - binary (Buffer, TypedArray, ArrayBuffer): '[binary]';
 *   - a node stream (an HTTP request or response, a socket), or a wrapper
 *     holding one in raw (Fastify's Request and Reply): streamSummary;
 *   - an object that hides itself, i.e. its toJSON gave nothing or it defines
 *     util.inspect.custom with no toJSON (fetch Headers, a credential class):
 *     '[ClassName]';
 *   - a cycle: '[circular]'; an object four levels down: the depth marker,
 *     unread; an array or object: at most MAX_ENTRIES entries, a header list
 *     masked (headerList), object keys printed as text (rekeyed); past
 *     MAX_TOTAL_ENTRIES entries in all (the budget), the entries marker, unread.
 */
function shapeValues(
  redact: RedactOptions,
  nesting: number,
  rootInUrl: boolean,
  budget: Budget,
): (this: unknown, key: string, value: unknown) => unknown {
  const parents = new WeakMap<object, object>();
  const inUrl = new WeakSet<object>();
  return function shape(this: unknown, key: string, value: unknown): unknown {
    const holder = this as Record<string, unknown>;
    // A key that names a secret (sig and the other query keys included), or an OAuth code key's code, is masked.
    if (masks(key, value, redact)) return placeholder(redact);
    // Under a URL-named key every value is a URL value, so a URL root makes them all one.
    const urlValued = rootInUrl || isUrlKey(key) || inUrl.has(holder);
    if (typeof value === 'string') return redactText(value, redact, nesting, urlValued, budget);
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
    const original = holder[key];
    if (original instanceof Error) {
      // Under a URL-named key the shape's message, stack and name are URL values, as its stack copy of the message is.
      const shaped = errorShape(original, redact, nesting, urlValued, budget);
      if (urlValued) inUrl.add(shaped);
      return shaped;
    }
    if (isBinary(original)) return '[binary]';
    const stream = streamOf(original);
    if (stream !== undefined) return streamSummary(stream);
    // toJSON gave nothing (value undefined, original an object): it chose not to be shown.
    if (value === undefined && original !== undefined) return classLabel(original as object);
    if (typeof value !== 'object' || value === null) return value;
    if (typeof (value as Record<symbol, unknown>)[INSPECT_CUSTOM] === 'function') return classLabel(value);
    let depth = 0;
    for (let above: object | undefined = holder; above !== undefined; above = parents.get(above)) {
      if (above === value) return '[circular]';
      depth += 1;
    }
    if (depth > MAX_FIELD_DEPTH) return TRUNCATED;
    const kept = Array.isArray(value) ? bounded(headerList(value, redact)) : rekeyed(bounded(value), redact);
    budget.left -= Object.keys(kept).length;
    if (budget.left < 0) return TRUNCATED_ENTRIES;
    parents.set(kept, holder);
    if (urlValued) inUrl.add(kept);
    return kept;
  };
}

/**
 * Any value as the logger prints it, the one policy behind every extra field,
 * message part, err, reserved value and bridged or printf argument. A string
 * goes through redactText. An object is taken in its JSON form, shaped by
 * shapeValues, then key-redacted with the logger's options (cookie,
 * authorization, password ...); a value that cannot be read (a throwing
 * getter or toJSON, a revoked Proxy) prints as '[unserializable]'. null
 * stays null; other primitives are returned unchanged. inUrl: the value sits
 * under a URL-named key, so every string in it is a URL value. budget: what
 * the printed value this one is part of may still read (a new one for a value
 * printed on its own).
 */
function printValue(value: unknown, redact: RedactOptions, nesting = 0, inUrl = false, budget = freshBudget()): unknown {
  if (typeof value === 'string') return redactText(value, redact, nesting, inUrl, budget);
  if (typeof value !== 'object') return value;
  try {
    return redactValue(JSON.parse(JSON.stringify(value, shapeValues(redact, nesting, inUrl, budget))) as unknown, redact);
  } catch {
    return UNSERIALIZABLE;
  }
}

/** A reserved value (call, code, peer, job, event) as one string, printed as any value is. */
function reservedText(value: unknown, redact: RedactOptions): string {
  return sanitizeLogValue(printValue(value, redact));
}

/** The log shape's `err`: {type, message}, the name and message printed as any other value is; an Error it cannot read says so. */
function errField(value: unknown, redact: RedactOptions): { type: string; message: string } {
  if (!(value instanceof Error)) return { type: typeof value, message: reservedText(value, redact) };
  try {
    return { type: reservedText(value.name, redact), message: safeString(value.message, redact) };
  } catch {
    return { type: 'Error', message: UNSERIALIZABLE };
  }
}

function nonNegativeMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? roundMs(value) : undefined;
}

function activeIds(): { trace_id: string; span_id: string } | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx !== undefined && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : undefined;
}

function buildEntry(
  core: Core,
  level: LogLevel,
  merged: Record<string, unknown>,
  message: string,
): Record<string, unknown> {
  const reserved: Record<string, unknown> = {};
  const extras: Record<string, Scalar> = {};
  for (const [rawKey, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    const key = toSnakeCase(plainText(rawKey, core.redact));
    if (OWNED.has(key)) continue;
    if (CALLER_RESERVED.has(key)) reserved[key] = value;
    // The key as given decides too: printing may drop the word that names a secret ('/login?token').
    else extras[key] = masks(rawKey, value, core.redact) ? placeholder(core.redact) : flatValue(key, value, core.redact);
  }

  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    service: core.identity.service,
    version: core.identity.version,
    event: typeof reserved['event'] === 'string' ? reservedText(reserved['event'], core.redact) : 'app.log',
    msg: safeString(message, core.redact),
  };

  const call = reserved['call'] === undefined ? '' : reservedText(reserved['call'], core.redact).split(/[?#]/)[0].trim();
  if (call !== '') entry['call'] = call;
  if (typeof reserved['code'] === 'string' || typeof reserved['code'] === 'number') {
    entry['code'] = reservedText(String(reserved['code']), core.redact);
  }
  const duration = nonNegativeMs(reserved['duration_ms']);
  if (duration !== undefined) entry['duration_ms'] = duration;
  if (reserved['peer'] !== undefined) entry['peer'] = reservedText(reserved['peer'], core.redact);
  const ids = activeIds();
  if (ids !== undefined) Object.assign(entry, ids);
  const job = reserved['job'] === undefined ? core.job : reservedText(reserved['job'], core.redact);
  if (job !== undefined) entry['job'] = job;
  if (reserved['err'] !== undefined) entry['err'] = errField(reserved['err'], core.redact);
  const queued = nonNegativeMs(reserved['queue_ms']);
  if (queued !== undefined) entry['queue_ms'] = queued;

  return Object.assign(entry, extras);
}

function textValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const err = value as { type: string; message: string };
    return JSON.stringify(`${err.type}: ${err.message}`);
  }
  if (typeof value === 'string') return value === '' || /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  return String(value);
}

/** FC_LOG_FORMAT=text: `time LEVEL service event msg key=value ...` on one line. */
function toText(entry: Record<string, unknown>): string {
  const { time, level, service, version: _version, event, msg, ...rest } = entry;
  const head = `${String(time)} ${String(level).toUpperCase()} ${String(service)} ${String(event)} ${String(msg)}`;
  return Object.entries(rest).reduce((line, [key, value]) => `${line} ${key}=${textValue(value)}`, head);
}

/** A message part: an Error as its message, printed as any value is (so is anything else), on one line. */
function stringifyArg(arg: unknown, redact: RedactOptions): string {
  if (typeof arg === 'string') return redactText(arg, redact);
  return sanitizeLogValue(printValue(arg instanceof Error ? arg.message || 'Error (no message)' : arg, redact));
}

/**
 * pino call shapes: (msg...), (obj, msg...), (err, msg...); a stream (an HTTP
 * request), or a wrapper holding one in raw, first is a message part.
 */
function splitArgs(args: unknown[], redact: RedactOptions): { fields: Record<string, unknown>; message: string } {
  const [first, ...rest] = args;
  const text = (parts: unknown[]): string => parts.map((part) => stringifyArg(part, redact)).join(' ');
  if (first instanceof Error) {
    return { fields: { err: first }, message: rest.length > 0 ? text(rest) : first.message };
  }
  if (first !== null && typeof first === 'object' && !Array.isArray(first) && streamOf(first) === undefined) {
    return { fields: first as Record<string, unknown>, message: text(rest) };
  }
  return { fields: {}, message: text(args) };
}

function render(core: Core, level: LogLevel, args: unknown[], bindings: Record<string, unknown>): string {
  const { fields, message } = splitArgs(args, core.redact);
  const entry = buildEntry(core, level, { ...bindings, ...fields }, message);
  return core.format === 'text' ? toText(entry) : JSON.stringify(entry);
}

/** A log call never throws for what it was given: a call it cannot read at all is one line saying so. */
function renderSafely(core: Core, level: LogLevel, args: unknown[], bindings: Record<string, unknown>): string {
  try {
    return render(core, level, args, bindings);
  } catch {
    return render(core, level, [UNSERIALIZABLE], {});
  }
}

/** Each logger's redaction options, so the console bridge redacts exactly as its logger does. */
const REDACT_OF = new WeakMap<Logger, RedactOptions>();

function makeLogger(core: Core, level: LevelSetting, bindings: Record<string, unknown>): Logger {
  const threshold = SEVERITY[level];
  const emit = (at: LogLevel, args: unknown[]): void => {
    if (SEVERITY[at] >= threshold) core.sink(renderSafely(core, at, args, bindings));
  };
  const logger: Logger = {
    level,
    trace: (...args) => emit('trace', args),
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    fatal: (...args) => emit('fatal', args),
    // pino parity: logging AT 'silent' writes nothing.
    silent: () => undefined,
    child: (childBindings, options) =>
      makeLogger(core, parseLevel(options?.level) ?? level, { ...bindings, ...childBindings }),
    isLevelEnabled: (candidate) =>
      (LOG_LEVELS as readonly string[]).includes(candidate) && SEVERITY[candidate as LogLevel] >= threshold,
  };
  REDACT_OF.set(logger, core.redact);
  return logger;
}

const stdoutSink = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const format: LogFormat =
    options.format ?? (env['FC_LOG_FORMAT']?.trim().toLowerCase() === 'text' ? 'text' : 'json');
  const core: Core = {
    identity: resolveServiceIdentity(env, { service: options.service, version: options.version }),
    job: firstNonBlank(env['JOB_NAME']),
    format,
    sink: options.sink ?? stdoutSink,
    redact: options.redact ?? {},
  };
  return makeLogger(core, options.level ?? parseLevel(env['LOG_LEVEL']) ?? 'info', options.bindings ?? {});
}

// ---------------------------------------------------------------------------
// Console bridge
// ---------------------------------------------------------------------------

type ConsoleMethod = (...args: unknown[]) => void;

/** The console methods the bridge replaces. `console` itself satisfies this. */
export interface ConsoleLike {
  log: ConsoleMethod;
  info: ConsoleMethod;
  warn: ConsoleMethod;
  error: ConsoleMethod;
  debug: ConsoleMethod;
}

const BRIDGED: ReadonlyArray<[keyof ConsoleLike, LogLevel]> = [
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
  ['debug', 'debug'],
];

/** The legacy scraper logger's own `[ISO timestamp] ` prefix: redundant with `time`, dropped. */
const LEADING_TIMESTAMP = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\]\s*/;
/** `[BROWSER POOL] `: a letter first, at most 64 characters, inner spaces allowed. */
const LEADING_TAG = /^\[([A-Za-z][^\[\]\r\n]{0,63})\]\s*/;
const PRINTF = /%[sdifjoOc]/;

function consoleArg(arg: unknown, redact: RedactOptions): string {
  if (typeof arg === 'string') return redactText(arg, redact);
  if (arg instanceof Error) return stackHeader(errorLabel(arg.name), sanitizeLogValue(printValue(arg.message, redact)));
  return sanitizeLogValue(printValue(arg, redact));
}

function consoleText(args: unknown[], redact: RedactOptions): string {
  const [first, ...rest] = args;
  if (typeof first === 'string' && PRINTF.test(first)) {
    return formatWithOptions(
      { breakLength: Number.POSITIVE_INFINITY, compact: true, colors: false },
      first,
      ...rest.map((arg) => printValue(arg, redact)),
    );
  }
  return args.map((arg) => consoleArg(arg, redact)).join(' ');
}

/** One bridged console call as the (fields, message) the logger prints; an unreadable call says so. */
function bridgeArgs(args: unknown[], redact: RedactOptions): [Record<string, unknown>, string] {
  try {
    let text = consoleText(args, redact).replace(LEADING_TIMESTAMP, '');
    const fields: Record<string, unknown> = { event: 'app.console' };
    // Only the caller's own first string writes a tag, never a printed value ('[Socket]', '[unserializable]').
    const tag = typeof args[0] === 'string' && args[0].startsWith('[') ? LEADING_TAG.exec(text) : null;
    if (tag !== null) {
      fields['tag'] = tag[1].trim();
      text = text.slice(tag[0].length);
    }
    const err = args.find((arg) => arg instanceof Error);
    if (err !== undefined) fields['err'] = err;
    return [fields, text];
  } catch {
    return [{ event: 'app.console' }, UNSERIALIZABLE];
  }
}

/**
 * Route console.log/info/warn/error/debug through `logger` as one app.console
 * line each (log -> info). A leading `[TAG]` (spaces allowed, e.g. `[BROWSER
 * POOL]`) that the first argument, a string, starts with becomes the `tag`
 * field, after dropping a leading `[ISO timestamp]`;
 * an Error argument becomes `err`. Every argument, printf arguments included,
 * is printed as a logger field value is, with the logger's own options: a
 * string that is a whole JSON object or array is key-redacted and made
 * compact; URLs lose query, fragment and userinfo; objects (plain, class
 * instances such as AxiosHeaders, Errors) are key-redacted in their JSON form,
 * and one that hides itself from util.inspect prints as `[ClassName]`. An
 * Error prints as V8 writes its header (`name: message`, the message alone
 * for an empty name, the name alone for an empty message), or as {name,
 * message, stack} under %o/%O/%j/%s, its message (the stack's copy too)
 * printed as any text is.
 * Other text, the format string included, is covered by the same policy as
 * msg: the secret-shape patterns (Bearer, JWT, ...), the URL stripping, and
 * the header-line and form rules where the whole text is one.
 * Returns an uninstall function that restores the original methods.
 *
 * A console call made while a bridged line is being written (a sink that itself
 * logs to console) goes straight to the original method instead of recursing.
 */
export function installConsoleBridge(logger: Logger, target: ConsoleLike = console): () => void {
  const originals: Array<[keyof ConsoleLike, ConsoleMethod]> = [];
  const redact = REDACT_OF.get(logger) ?? {};
  let writing = false;

  for (const [method, level] of BRIDGED) {
    const original = target[method];
    originals.push([method, original]);
    target[method] = (...args: unknown[]) => {
      if (writing) {
        original.apply(target, args);
        return;
      }
      writing = true;
      try {
        logger[level](...bridgeArgs(args, redact));
      } finally {
        writing = false;
      }
    };
  }

  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}
