/**
 * Shared fixtures for the packaging-contract tests (1.7.0 subpath exports).
 *
 * These tests assert the PUBLISHED shape of the package rather than the
 * behaviour of any one module: what `exports` resolves to, what a consumer's
 * module graph actually pulls in, and what lands in the tarball. They therefore
 * run real `node` child processes against the built `dist/`, using Node's own
 * resolver and package self-reference, so the assertions are ground truth
 * rather than a re-implementation of resolution.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PKG_ROOT = resolve(__dirname, '..', '..');
export const PKG_NAME = '@figurecollecting/fc-shared';

export interface PackageJson {
  name: string;
  version: string;
  files: string[];
  exports: Record<string, Record<string, string> | string>;
  scripts: Record<string, string>;
}

export function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

/**
 * The STATELESS modules fc-coordinator imports (plan §A.5). `stores/*` and
 * `api/*` are deliberately absent: they are client-side singletons and an axios
 * client for legacy fc-backend, and giving them a second resolution path is how
 * you get two zustand stores and a silent auth bug.
 */
export interface SubpathSpec {
  subpath: string;
  types: string;
  import: string;
  require: string;
  /** Runtime (non-type) values a consumer must get from this subpath. */
  runtimeExports: string[];
}

export const SUBPATHS: readonly SubpathSpec[] = [
  {
    subpath: './utils/trace',
    types: './dist/utils/trace.d.ts',
    import: './dist/utils/trace.mjs',
    require: './dist/utils/trace.js',
    runtimeExports: ['getActiveTraceIds', 'getTraceContext'],
  },
  {
    subpath: './utils/sanitize',
    types: './dist/utils/sanitize.d.ts',
    import: './dist/utils/sanitize.mjs',
    require: './dist/utils/sanitize.js',
    runtimeExports: [
      'redactValue',
      'redactAttributes',
      'DEFAULT_SENSITIVE_KEY_PATTERN',
      'DEFAULT_SECRET_VALUE_PATTERNS',
    ],
  },
  {
    subpath: './utils/logger',
    types: './dist/utils/logger.d.ts',
    import: './dist/utils/logger.mjs',
    require: './dist/utils/logger.js',
    runtimeExports: ['configureLogger', 'sanitizeLogValue', 'createLogger'],
  },
  {
    subpath: './types',
    types: './dist/types/index.d.ts',
    import: './dist/types/index.mjs',
    require: './dist/types/index.js',
    runtimeExports: ['MFC_LIST_LIMITS'],
  },
];

/**
 * The NODE-ONLY server subpaths (lg-logging U1). Built separately with
 * --platform=node so the browser entry points stay byte-identical; nothing in
 * the barrel or the browser-safe subpaths may ever reach them.
 */
export const SERVER_SUBPATHS: readonly SubpathSpec[] = [
  {
    subpath: './server/log',
    types: './dist/server/log.d.ts',
    import: './dist/server/log.mjs',
    require: './dist/server/log.js',
    runtimeExports: ['createLogger', 'installConsoleBridge', 'resolveServiceIdentity', 'RESERVED_LOG_KEYS'],
  },
  {
    subpath: './server/tracing',
    types: './dist/server/tracing.d.ts',
    import: './dist/server/tracing.mjs',
    require: './dist/server/tracing.js',
    runtimeExports: [
      'startTracing',
      'ESM_LOADER_HOOK',
      'esmLoaderHookPath',
      'RedactingSpanExporter',
      'AllowlistPropagator',
      'DEFAULT_PROPAGATION_HOSTS',
    ],
  },
  {
    subpath: './server/connect',
    types: './dist/server/connect.d.ts',
    import: './dist/server/connect.mjs',
    require: './dist/server/connect.js',
    runtimeExports: ['rpcServerInterceptor', 'rpcClientInterceptor'],
  },
  {
    subpath: './server/express',
    types: './dist/server/express.d.ts',
    import: './dist/server/express.mjs',
    require: './dist/server/express.js',
    runtimeExports: ['httpLogMiddleware'],
  },
  {
    subpath: './server/job',
    types: './dist/server/job.d.ts',
    import: './dist/server/job.mjs',
    require: './dist/server/job.js',
    runtimeExports: ['runJob', 'currentTraceparent', 'withTraceparent'],
  },
];

/** The published log contract consumers validate their own lines against. */
export const LOG_SCHEMA_SUBPATH = './server/log-shape.schema.json';
export const LOG_SCHEMA_FILE = './schema/log-shape.schema.json';

/**
 * What a browser-reachable module graph must never resolve: the OpenTelemetry
 * SDK, exporters and instrumentation, and Connect. (Node builtins are checked
 * by the esbuild browser bundle, where axios resolves to its browser build.)
 */
export const SERVER_ONLY_SPECIFIER =
  /^(?:@opentelemetry\/(?:sdk-|exporter-|instrumentation|resources|core|context-async-hooks)|@connectrpc\/)/;

/**
 * Packages a stateless subpath must never drag into a consumer's module graph.
 * A Node service importing `getTraceContext` from the barrel pulls all three.
 */
export const FORBIDDEN_DEPENDENCIES = ['axios', 'zustand', 'react'] as const;

/** Bare module specifier for a subpath, as a consumer would write it. */
export function specifierFor(subpath: string): string {
  return subpath === '.' ? PKG_NAME : PKG_NAME + subpath.slice(1);
}

function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const mtime = statSync(join(entry.parentPath, entry.name)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

let ensured = false;

/**
 * Guarantee `dist/` reflects the working tree. CI builds before it tests, so
 * this is a stat check there; locally it rebuilds rather than silently asserting
 * against a stale bundle.
 */
export function ensureBuilt(): void {
  if (ensured) return;
  const stamp = join(PKG_ROOT, 'dist', 'index.mjs');
  const stale =
    !existsSync(stamp) ||
    newestMtimeMs(join(PKG_ROOT, 'src')) > statSync(stamp).mtimeMs ||
    statSync(join(PKG_ROOT, 'package.json')).mtimeMs > statSync(stamp).mtimeMs;
  if (stale) run('npm', ['run', 'build']);
  ensured = true;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: PKG_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      command + ' ' + args.join(' ') + ' exited ' + String(result.status) +
      '\n--- stdout ---\n' + String(result.stdout) +
      '\n--- stderr ---\n' + String(result.stderr)
    );
  }
  return result.stdout.trim();
}

/** Evaluate ESM source in a child node process rooted at the package. */
export function runNodeEsm(source: string): string {
  return run(process.execPath, ['--input-type=module', '-e', source]);
}

/** Evaluate CommonJS source in a child node process rooted at the package. */
export function runNodeCjs(source: string): string {
  return run(process.execPath, ['-e', source]);
}

export function runTsc(args: string[]): string {
  return run(join(PKG_ROOT, 'node_modules', '.bin', 'tsc'), args);
}

export function runNpm(args: string[]): string {
  return run('npm', args);
}
