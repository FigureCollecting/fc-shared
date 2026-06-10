/**
 * Production-safe debug logging utility (framework-agnostic)
 *
 * Configure via environment or runtime:
 * - Set FC_DEBUG=true to enable debug logs
 * - Set FC_DEBUG_LEVEL=verbose|info|warn|error
 *
 * Or call configureLogger() at app startup to set options.
 */

type LogLevel = 'verbose' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  verbose: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Maximum length for sanitized log strings (prevents log flooding)
const MAX_LOG_STRING_LENGTH = 1000;

// Global config (can be set by consumers)
let globalDebug = false;
let globalLevel: LogLevel = 'error';

/**
 * Configure the logger at app startup.
 */
export function configureLogger(options: {
  debug?: boolean;
  level?: LogLevel;
}): void {
  if (options.debug !== undefined) globalDebug = options.debug;
  if (options.level !== undefined) globalLevel = options.level;
}

/**
 * Sanitize a value for safe logging to prevent log injection attacks.
 */
export const sanitizeLogValue = (value: unknown): string => {
  let stringified: string;

  if (value === null) {
    stringified = 'null';
  } else if (value === undefined) {
    stringified = 'undefined';
  } else if (typeof value === 'string') {
    stringified = value;
  } else if (value instanceof Error) {
    stringified = value.message || 'Error (no message)';
  } else {
    try {
      const result = JSON.stringify(value);
      stringified = result ?? String(value);
    } catch {
      stringified = String(value);
    }
  }

  // Remove newlines, carriage returns, and ANSI escape codes
  // eslint-disable-next-line no-control-regex
  let sanitized = stringified.replace(/[\r\n]/g, ' ').replace(/\x1b\[[0-9;]*m/g, '');

  // Truncate if too long
  if (sanitized.length > MAX_LOG_STRING_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LOG_STRING_LENGTH) + '...[truncated]';
  }
  return sanitized;
};

/**
 * Sanitize all arguments into a safe log message string.
 */
const sanitizeArgs = (args: unknown[]): string => {
  return args.map(arg => sanitizeLogValue(arg)).join(' ');
};

class Logger {
  private module: string;

  constructor(module: string) {
    this.module = module;
  }

  private get enabled(): boolean {
    return globalDebug;
  }

  private get level(): number {
    return LOG_LEVELS[globalLevel] ?? LOG_LEVELS.error;
  }

  private format(...args: unknown[]): string[] {
    return [`[${this.module}]`, new Date().toISOString(), sanitizeArgs(args)];
  }

  verbose(...args: unknown[]) {
    if (this.enabled && this.level <= LOG_LEVELS.verbose) {
      console.log(...this.format(...args));
    }
  }

  info(...args: unknown[]) {
    if (this.enabled && this.level <= LOG_LEVELS.info) {
      console.info(...this.format(...args));
    }
  }

  warn(...args: unknown[]) {
    if (this.enabled && this.level <= LOG_LEVELS.warn) {
      console.warn(...this.format(...args));
    }
  }

  error(...args: unknown[]) {
    // Always log errors when debug is on
    if (this.enabled) {
      console.error(...this.format(...args));
    }
  }

  debug(...args: unknown[]) {
    if (this.enabled) {
      console.log(...this.format(...args));
    }
  }
}

// Factory function
export const createLogger = (module: string): Logger => {
  return new Logger(module);
};

export default Logger;
