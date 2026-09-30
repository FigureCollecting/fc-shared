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
import { errorField, roundMs } from './fields';

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
  return sanitizeLogValue(redactString(value, redact));
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
      if (value instanceof Date) return value.toISOString();
      return sanitizeLogValue(redactValue(value, { ...redact, maxDepth: MAX_FIELD_DEPTH }));
    default:
      return `[${typeof value}]`;
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
  if (reserved['err'] !== undefined) entry['err'] = errorField(reserved['err'], core.redact);
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

function stringifyArg(arg: unknown): string {
  return typeof arg === 'string' ? arg : sanitizeLogValue(arg);
}

/** pino call shapes: (msg...), (obj, msg...), (err, msg...). */
function splitArgs(args: unknown[]): { fields: Record<string, unknown>; message: string } {
  const [first, ...rest] = args;
  if (first instanceof Error) {
    return { fields: { err: first }, message: rest.length > 0 ? rest.map(stringifyArg).join(' ') : first.message };
  }
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    return { fields: first as Record<string, unknown>, message: rest.map(stringifyArg).join(' ') };
  }
  return { fields: {}, message: args.map(stringifyArg).join(' ') };
}

function render(core: Core, level: LogLevel, args: unknown[], bindings: Record<string, unknown>): string {
  const { fields, message } = splitArgs(args);
  const entry = buildEntry(core, level, { ...bindings, ...fields }, message);
  return core.format === 'text' ? toText(entry) : JSON.stringify(entry);
}

function makeLogger(core: Core, level: LevelSetting, bindings: Record<string, unknown>): Logger {
  const threshold = SEVERITY[level];
  const emit = (at: LogLevel, args: unknown[]): void => {
    if (SEVERITY[at] >= threshold) core.sink(render(core, at, args, bindings));
  };
  return {
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

const LEADING_TAG = /^\[([^\]\s]{1,64})\]\s*/;
const PRINTF = /%[sdifjoOc]/;

/** A string that is a (possibly pretty-printed) JSON document, re-emitted compact. */
function compactJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

function consoleArg(arg: unknown): string {
  if (typeof arg === 'string') return compactJson(arg);
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  return sanitizeLogValue(arg);
}

function consoleText(args: unknown[]): string {
  const [first] = args;
  if (typeof first === 'string' && PRINTF.test(first)) {
    return formatWithOptions({ breakLength: Number.POSITIVE_INFINITY, compact: true, colors: false }, ...args);
  }
  return args.map(consoleArg).join(' ');
}

/**
 * Route console.log/info/warn/error/debug through `logger` as one app.console
 * line each (log -> info). A leading `[TAG]` becomes the `tag` field, an Error
 * argument becomes `err`, and a pretty-printed JSON string is collapsed to one
 * line. Returns an uninstall function that restores the original methods.
 *
 * A console call made while a bridged line is being written (a sink that itself
 * logs to console) goes straight to the original method instead of recursing.
 */
export function installConsoleBridge(logger: Logger, target: ConsoleLike = console): () => void {
  const originals: Array<[keyof ConsoleLike, ConsoleMethod]> = [];
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
        let text = consoleText(args);
        const fields: Record<string, unknown> = { event: 'app.console' };
        const tag = LEADING_TAG.exec(text);
        if (tag !== null) {
          fields['tag'] = tag[1];
          text = text.slice(tag[0].length);
        }
        const err = args.find((arg) => arg instanceof Error);
        if (err !== undefined) fields['err'] = err;
        logger[level](fields, text);
      } finally {
        writing = false;
      }
    };
  }

  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}
