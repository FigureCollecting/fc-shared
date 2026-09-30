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
 * Every value the logger prints (msg and its parts, err.message, each extra
 * field, bridged and printf console arguments) goes through one policy: a URL
 * loses its query, fragment and userinfo; a string that is a whole JSON object
 * or array is key-redacted; objects are key-redacted in their JSON form (see
 * printValue). A reserved key other than call and err is typed, not redacted.
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
import { stripUrl } from './redact';

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

function parseLevel(value: string | undefined): LevelSetting | undefined {
  const normalised = value?.trim().toLowerCase();
  return normalised !== undefined && normalised in SEVERITY ? (normalised as LevelSetting) : undefined;
}

/** `itemId` -> `item_id`, `HTTP-Status` -> `http_status`; never empty, never leading digit. */
export function toSnakeCase(key: string): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
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

function isSensitive(key: string, redact: RedactOptions): boolean {
  const pattern = redact.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;
  pattern.lastIndex = 0;
  return pattern.test(key);
}

function safeString(value: string, redact: RedactOptions): string {
  return sanitizeLogValue(redactText(value, redact));
}

/** Flatten one extra field to a scalar the schema accepts. */
function flatValue(key: string, value: unknown, redact: RedactOptions): Scalar {
  if (value === null) return null;
  if (isSensitive(key, redact)) return redact.placeholder ?? '[REDACTED]';
  switch (typeof value) {
    case 'string':
      return safeString(value, redact);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'object':
      return sanitizeLogValue(printValue(value, redact));
    default:
      return `[${typeof value}]`;
  }
}

/** util.inspect's hook: an object that defines it has chosen how it is shown. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
/** Entries kept per array or object; past it, MAX_ENTRIES - 1 and a count of the rest. */
const MAX_ENTRIES = 100;
const TRUNCATED = '[truncated:max-depth]';
/** What a value (or a whole call) the logger cannot read prints as. */
const UNSERIALIZABLE = '[unserializable]';

/**
 * A URL anywhere in text: a scheme (at most 32 characters, so a long word
 * costs linear time), optional userinfo (up to the last '@' before the path),
 * host and path, then a query or fragment that runs to the next space or quote.
 */
const URL_IN_TEXT = /([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/?#"'<>`]*@)?([^\s?#"'<>`]*)(?:[?#][^\s"'<>`]*)?/gi;
/** A whole value that is a path (or //host/path) carrying a query or fragment. */
const PATH_WITH_QUERY = /^\/\S*[?#]/;

/**
 * Text with the query, fragment and userinfo of every `scheme://` URL in it
 * removed, and a whole path value cut at its query (lg-logging plan-v2: the
 * logger strips query strings). The rest of the text is kept as written.
 */
function stripUrls(text: string): string {
  const trimmed = text.trim();
  if (PATH_WITH_QUERY.test(trimmed)) return stripUrl(trimmed);
  return text.replace(URL_IN_TEXT, '$1$2');
}

/** The parsed value of a string that is, as a whole, a JSON object or array. */
function jsonDocument(text: string): object | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as object;
  } catch {
    return undefined;
  }
}

/**
 * A string as the logger prints it. A whole JSON object or array is printed as
 * an object is and re-emitted compact, up to four strings deep (a fifth prints
 * the depth marker, never its text). Any other text has the secret-shape
 * patterns masked and its URLs stripped.
 */
function redactText(text: string, redact: RedactOptions, nesting = 0): string {
  const doc = jsonDocument(text);
  if (doc === undefined) return stripUrls(redactString(text, redact));
  return nesting < MAX_FIELD_DEPTH ? JSON.stringify(printValue(doc, redact, nesting + 1)) : TRUNCATED;
}

function isBinary(value: unknown): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/** `[ClassName]`, or `[object]` when there is no class name. */
function classLabel(value: object): string {
  const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return `[${typeof name === 'string' && name !== '' ? name : 'object'}]`;
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
 * The JSON.stringify replacer behind printValue. JSON.stringify has already
 * applied toJSON (so AxiosHeaders, a URL or a Date arrive as their JSON form);
 * the original is read back from the holder.
 *   - a string: redactText; a bigint: '10n'; a function or symbol: '[function]';
 *   - an Error: {name, message, stack}, never its own properties (an
 *     AxiosError's config and response), whatever its toJSON says;
 *   - binary (Buffer, TypedArray, ArrayBuffer): '[binary]';
 *   - an object that hides itself, i.e. its toJSON gave nothing or it defines
 *     util.inspect.custom with no toJSON (fetch Headers, a credential class):
 *     '[ClassName]';
 *   - a cycle: '[circular]'; an object four levels down: the depth marker,
 *     unread; an array or object: at most MAX_ENTRIES entries.
 */
function shapeValues(redact: RedactOptions, nesting: number): (this: unknown, key: string, value: unknown) => unknown {
  const parents = new WeakMap<object, object>();
  return function shape(this: unknown, key: string, value: unknown): unknown {
    if (typeof value === 'string') return redactText(value, redact, nesting);
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
    const holder = this as Record<string, unknown>;
    const original = holder[key];
    if (original instanceof Error) return { name: original.name, message: original.message, stack: original.stack };
    if (isBinary(original)) return '[binary]';
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
    const kept = bounded(value);
    parents.set(kept, holder);
    return kept;
  };
}

/**
 * Any value as the logger prints it, the one policy behind every extra field,
 * message part, err and bridged or printf argument. A string goes
 * through redactText. An object is taken in its JSON form, shaped by
 * shapeValues, then key-redacted with the logger's options (cookie,
 * authorization, password ...); a value that cannot be read (a throwing
 * getter or toJSON, a revoked Proxy) prints as '[unserializable]'. null
 * stays null; other primitives are returned unchanged.
 */
function printValue(value: unknown, redact: RedactOptions, nesting = 0): unknown {
  if (typeof value === 'string') return redactText(value, redact, nesting);
  if (typeof value !== 'object') return value;
  try {
    return redactValue(JSON.parse(JSON.stringify(value, shapeValues(redact, nesting))) as unknown, redact);
  } catch {
    return UNSERIALIZABLE;
  }
}

/** The log shape's `err`: {type, message}, the message printed as any other text is. */
function errField(value: unknown, redact: RedactOptions): { type: string; message: string } {
  if (value instanceof Error) return { type: value.name, message: safeString(value.message, redact) };
  return { type: typeof value, message: sanitizeLogValue(printValue(value, redact)) };
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
    const key = toSnakeCase(rawKey);
    if (OWNED.has(key)) continue;
    if (CALLER_RESERVED.has(key)) reserved[key] = value;
    else extras[key] = flatValue(key, value, core.redact);
  }

  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    service: core.identity.service,
    version: core.identity.version,
    event: typeof reserved['event'] === 'string' ? sanitizeLogValue(reserved['event']) : 'app.log',
    msg: safeString(message, core.redact),
  };

  const call = reserved['call'] === undefined ? '' : sanitizeLogValue(reserved['call']).split(/[?#]/)[0].trim();
  if (call !== '') entry['call'] = call;
  if (typeof reserved['code'] === 'string' || typeof reserved['code'] === 'number') {
    entry['code'] = sanitizeLogValue(String(reserved['code']));
  }
  const duration = nonNegativeMs(reserved['duration_ms']);
  if (duration !== undefined) entry['duration_ms'] = duration;
  if (reserved['peer'] !== undefined) entry['peer'] = sanitizeLogValue(reserved['peer']);
  const ids = activeIds();
  if (ids !== undefined) Object.assign(entry, ids);
  const job = reserved['job'] === undefined ? core.job : sanitizeLogValue(reserved['job']);
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

/** A message part: an Error as its message, anything else printed as a field value is, on one line. */
function stringifyArg(arg: unknown, redact: RedactOptions): string {
  if (typeof arg === 'string') return redactText(arg, redact);
  return sanitizeLogValue(arg instanceof Error ? arg : printValue(arg, redact));
}

/** pino call shapes: (msg...), (obj, msg...), (err, msg...). */
function splitArgs(args: unknown[], redact: RedactOptions): { fields: Record<string, unknown>; message: string } {
  const [first, ...rest] = args;
  const text = (parts: unknown[]): string => parts.map((part) => stringifyArg(part, redact)).join(' ');
  if (first instanceof Error) {
    return { fields: { err: first }, message: rest.length > 0 ? text(rest) : first.message };
  }
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
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
      makeLogger(core, options?.level ?? level, { ...bindings, ...childBindings }),
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
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
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
    const tag = LEADING_TAG.exec(text);
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
 * POOL]`) becomes the `tag` field, after dropping a leading `[ISO timestamp]`;
 * an Error argument becomes `err`. Every argument, printf arguments included,
 * is printed as a logger field value is, with the logger's own options: a
 * string that is a whole JSON object or array is key-redacted and made
 * compact; URLs lose query, fragment and userinfo; objects (plain, class
 * instances such as AxiosHeaders, Errors) are key-redacted in their JSON form,
 * and one that hides itself from util.inspect prints as `[ClassName]`. An
 * Error prints as `name: message`, or as {name, message, stack} under
 * %o/%O/%j/%s. Other text, the format string included, is covered only by the
 * secret-shape patterns (Bearer, JWT, ...) and the URL stripping, as msg is.
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
