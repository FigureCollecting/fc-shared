/**
 * What a consumer actually loads. Every assertion here runs a real `node`
 * child process against the built package and uses Node's own resolver via
 * package self-reference, so the exports map, the emitted ESM chunks and the
 * CommonJS output are all exercised exactly as a downstream service would.
 *
 * The point of the 1.7.0 subpaths is graph purity: fc-coordinator imports
 * `getTraceContext` without pulling in axios, zustand or react. A test that
 * only checked "the import works" would pass on the barrel too.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORBIDDEN_DEPENDENCIES,
  PKG_NAME,
  PKG_ROOT,
  SUBPATHS,
  ensureBuilt,
  runNodeCjs,
  runNodeEsm,
  specifierFor,
} from './package-contract';

const BUILD_BUDGET_MS = 600_000;

describe('subpath resolution and module-graph purity', () => {
  const cases = SUBPATHS.map((spec) => [spec.subpath, spec] as const);

  beforeAll(() => {
    ensureBuilt();
  }, BUILD_BUDGET_MS);

  it.each(cases)('%s: every declared condition target exists in dist', (_subpath, spec) => {
    for (const target of [spec.types, spec.import, spec.require]) {
      expect({ target, exists: existsSync(join(PKG_ROOT, target)) }).toEqual({ target, exists: true });
    }
  });

  it.each(cases)('%s: loads under Node ESM and exposes its runtime values', (_subpath, spec) => {
    const source =
      "const m = await import('" + specifierFor(spec.subpath) + "');" +
      'console.log(JSON.stringify(Object.keys(m)));';
    const exported = JSON.parse(runNodeEsm(source)) as string[];
    for (const name of spec.runtimeExports) expect(exported).toContain(name);
  });

  it.each(cases)('%s: loads under CommonJS and exposes its runtime values', (_subpath, spec) => {
    const source =
      "const m = require('" + specifierFor(spec.subpath) + "');" +
      'console.log(JSON.stringify(Object.keys(m)));';
    const exported = JSON.parse(runNodeCjs(source)) as string[];
    for (const name of spec.runtimeExports) expect(exported).toContain(name);
  });

  it.each(cases)('%s: drags no client dependency into the ESM graph', (_subpath, spec) => {
    // A resolve hook records every specifier Node resolves while loading the
    // subpath, transitively. This is the graph itself, not a guess at it.
    const source =
      "const { registerHooks } = require('node:module');" +
      'const seen = [];' +
      'registerHooks({ resolve(specifier, context, nextResolve) { seen.push(specifier); return nextResolve(specifier, context); } });' +
      "import('" + specifierFor(spec.subpath) + "').then(() => { console.log(JSON.stringify(seen)); });";
    const resolved = JSON.parse(runNodeCjs(source)) as string[];
    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      const hits = resolved.filter(
        (specifier) => specifier === forbidden || specifier.startsWith(forbidden + '/')
      );
      expect({ forbidden, hits }).toEqual({ forbidden, hits: [] });
    }
  });

  it.each(cases)('%s: drags no client dependency into the CommonJS graph', (_subpath, spec) => {
    const source =
      "require('" + specifierFor(spec.subpath) + "');" +
      'console.log(JSON.stringify(Object.keys(require.cache)));';
    const loaded = JSON.parse(runNodeCjs(source)) as string[];
    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      const hits = loaded.filter((path) => path.includes('/node_modules/' + forbidden + '/'));
      expect({ forbidden, hits }).toEqual({ forbidden, hits: [] });
    }
  });

  it('keeps the barrel a superset: every subpath value is still exported from the root', () => {
    const source =
      "const m = await import('" + PKG_NAME + "');" + 'console.log(JSON.stringify(Object.keys(m)));';
    const rootExports = JSON.parse(runNodeEsm(source)) as string[];
    for (const spec of SUBPATHS) {
      for (const name of spec.runtimeExports) expect(rootExports).toContain(name);
    }
    // 1.6.0 shipped 74 named exports; 1.7.0 is additive, so the surface may
    // grow but must never shrink.
    expect(rootExports.length).toBeGreaterThanOrEqual(74);
  });

  it('shares one logger instance between the barrel and ./utils/logger under ESM', () => {
    // The logger holds module-level config (globalDebug/globalLevel). If the
    // barrel and the subpath resolved to separate copies, configuring through
    // one would silently not apply to the other.
    const source =
      "const barrel = await import('" + PKG_NAME + "');" +
      "const subpath = await import('" + PKG_NAME + "/utils/logger');" +
      "barrel.configureLogger({ debug: true, level: 'verbose' });" +
      'let lines = 0;' +
      'const realInfo = console.info;' +
      'console.info = () => { lines += 1; };' +
      "subpath.createLogger('probe').info('configured through the barrel');" +
      'console.info = realInfo;' +
      'console.log(JSON.stringify({ lines }));';
    expect(JSON.parse(runNodeEsm(source))).toEqual({ lines: 1 });
  });

  it('shares one logger instance between the barrel and ./utils/logger under CommonJS', () => {
    const source =
      "const barrel = require('" + PKG_NAME + "');" +
      "const subpath = require('" + PKG_NAME + "/utils/logger');" +
      "barrel.configureLogger({ debug: true, level: 'verbose' });" +
      'let lines = 0;' +
      'const realInfo = console.info;' +
      'console.info = () => { lines += 1; };' +
      "subpath.createLogger('probe').info('configured through the barrel');" +
      'console.info = realInfo;' +
      'console.log(JSON.stringify({ lines }));';
    expect(JSON.parse(runNodeCjs(source))).toEqual({ lines: 1 });
  });
});
