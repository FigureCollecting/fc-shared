/**
 * The `exports` map is the package's public contract. These assertions are
 * static (no build required) and guard three things: that the new subpaths are
 * declared correctly, that the root barrel is untouched, and that the stateful
 * modules stay unreachable by a second path.
 */
import {
  LOG_SCHEMA_FILE,
  LOG_SCHEMA_SUBPATH,
  SERVER_SUBPATHS,
  SUBPATHS,
  readPackageJson,
} from './package-contract';

/** true when `version` is at least `floor` (both plain x.y.z). */
function atLeast(version: string, floor: string): boolean {
  const actual = version.split('.').map(Number);
  const minimum = floor.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

describe('package.json exports map', () => {
  const pkg = readPackageJson();
  const cases = SUBPATHS.map((spec) => [spec.subpath, spec] as const);

  it('leaves the root barrel resolution unchanged', () => {
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
      require: './dist/index.js',
    });
    expect(pkg.exports['./package.json']).toBe('./package.json');
  });

  it.each(cases)('%s resolves for types, import and require', (_subpath, spec) => {
    expect(pkg.exports[spec.subpath]).toEqual({
      types: spec.types,
      import: spec.import,
      require: spec.require,
    });
  });

  it.each(cases)('%s lists "types" first, as TypeScript condition order requires', (_subpath, spec) => {
    const entry = pkg.exports[spec.subpath] as Record<string, string> | undefined;
    expect(entry).toBeDefined();
    expect(Object.keys(entry as Record<string, string>)[0]).toBe('types');
  });

  it('gives no subpath to the stateful modules', () => {
    // A second resolution path to a zustand store or the axios client would let
    // one half of an app hold a different singleton from the other half.
    const declared = Object.keys(pkg.exports);
    expect(declared.filter((entry) => entry.startsWith('./stores'))).toEqual([]);
    expect(declared.filter((entry) => entry.startsWith('./api'))).toEqual([]);
  });

  it('exports the shippable toolchain baseline', () => {
    expect(pkg.exports['./tsconfig.base.json']).toBe('./tsconfig.base.json');
  });

  it('publishes tsconfig.base.json alongside dist', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('tsconfig.base.json');
  });

  it('is at or beyond 1.7.0, the additive minor that added subpath exports', () => {
    expect(atLeast(pkg.version, '1.7.0')).toBe(true);
  });
});

describe('package.json exports map: node-only server subpaths (1.8.0)', () => {
  const pkg = readPackageJson() as ReturnType<typeof readPackageJson> & {
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
    dependencies: Record<string, string>;
  };
  const cases = SERVER_SUBPATHS.map((spec) => [spec.subpath, spec] as const);

  it.each(cases)('%s resolves for types, import and require, types first', (_subpath, spec) => {
    expect(pkg.exports[spec.subpath]).toEqual({ types: spec.types, import: spec.import, require: spec.require });
    expect(Object.keys(pkg.exports[spec.subpath] as Record<string, string>)[0]).toBe('types');
  });

  it('publishes the log-shape schema at a stable subpath', () => {
    expect(pkg.exports[LOG_SCHEMA_SUBPATH]).toBe(LOG_SCHEMA_FILE);
    expect(pkg.files).toContain('schema');
  });

  it('adds no runtime dependency: the OpenTelemetry SDK and Connect are OPTIONAL peers', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@opentelemetry/api', 'axios', 'zustand']);
    const serverPeers = [
      '@connectrpc/connect',
      '@opentelemetry/context-async-hooks',
      '@opentelemetry/core',
      '@opentelemetry/exporter-trace-otlp-grpc',
      '@opentelemetry/instrumentation',
      '@opentelemetry/resources',
      '@opentelemetry/sdk-trace',
    ];
    for (const peer of serverPeers) {
      expect({ peer, range: typeof pkg.peerDependencies[peer], optional: pkg.peerDependenciesMeta[peer]?.optional })
        .toEqual({ peer, range: 'string', optional: true });
    }
  });

  it('is at or beyond 1.8.0, the additive minor that added the server subpaths', () => {
    expect(atLeast(pkg.version, '1.8.0')).toBe(true);
  });
});
