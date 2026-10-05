/**
 * ESM apps must preload @opentelemetry/instrumentation/hook.mjs (lg-logging
 * review, SHOULD: scraper and fc-aggregation are "type": "module", so without
 * the loader instrumentation-pg produces no spans and U9 fails live).
 *
 * Proven with real node processes against the built package: an instrumentation
 * registered by startTracing patches an ESM dependency ONLY when the loader
 * hook is preloaded, by its bare specifier or by the path esmLoaderHookPath()
 * returns. The fixture lives under the package root so self-reference and the
 * OpenTelemetry peers resolve exactly as they would in a consuming app.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESM_LOADER_HOOK, esmLoaderHookPath } from '../../src/server/tracing';
import { PKG_ROOT, ensureBuilt } from '../package/package-contract';

const BUILD_BUDGET_MS = 600_000;

const PRELOAD = `
import { startTracing } from '@figurecollecting/fc-shared/server/tracing';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';

class ProbeInstrumentation extends InstrumentationBase {
  constructor() { super('fc-esm-probe-instrumentation', '1.0.0', {}); }
  init() {
    return [new InstrumentationNodeModuleDefinition('fc-esm-probe', ['*'], (exports) => {
      this._wrap(exports, 'hello', () => () => 'patched');
      return exports;
    })];
  }
}

startTracing('esm-probe', { env: {}, instrumentations: [new ProbeInstrumentation()] });
`;

const APP = `
import { hello } from 'fc-esm-probe';
console.log(hello());
`;

describe('ESM apps need the OpenTelemetry loader hook', () => {
  let dir: string;

  beforeAll(() => {
    ensureBuilt();
    dir = mkdtempSync(join(PKG_ROOT, '.tmp-esm-hook-'));
    const probe = join(dir, 'node_modules', 'fc-esm-probe');
    mkdirSync(probe, { recursive: true });
    writeFileSync(
      join(probe, 'package.json'),
      JSON.stringify({ name: 'fc-esm-probe', version: '1.0.0', type: 'module', exports: './index.js' }),
    );
    writeFileSync(join(probe, 'index.js'), "export function hello() { return 'original'; }\n");
    writeFileSync(join(dir, 'preload.mjs'), PRELOAD);
    writeFileSync(join(dir, 'app.mjs'), APP);
  }, BUILD_BUDGET_MS);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(flags: string[]): string {
    const result = spawnSync(process.execPath, [...flags, '--import', './preload.mjs', 'app.mjs'], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`node exited ${String(result.status)}: ${result.stderr}`);
    return result.stdout.trim();
  }

  it('leaves an ESM dependency unpatched when only --import is used', () => {
    expect(run([])).toBe('original');
  });

  it('patches it when the hook is preloaded by its bare specifier', () => {
    expect(run([`--experimental-loader=${ESM_LOADER_HOOK}`])).toBe('patched');
  });

  it('patches it when the hook is preloaded by the path esmLoaderHookPath() resolves', () => {
    const hook = pathToFileURL(esmLoaderHookPath(dir)).href;
    expect(run([`--experimental-loader=${hook}`])).toBe('patched');
  });
});
