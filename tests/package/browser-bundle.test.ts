/**
 * The browser build stays browser-only (lg-logging U1 acceptance: "browser
 * entry bundle has no @opentelemetry/sdk-* import"). The server subpaths are a
 * separate esbuild run with --platform=node, so the browser entry points'
 * esbuild invocation, and therefore its output, is untouched.
 *
 * esbuild is run here with --platform=browser over the real sources: a Node
 * builtin anywhere in the graph fails the build outright, and the metafile
 * lists every input that was bundled.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { PKG_ROOT, SUBPATHS, ensureBuilt, readPackageJson } from './package-contract';

const BUILD_BUDGET_MS = 600_000;
const SERVER_PACKAGE = /node_modules\/(?:@opentelemetry\/(?:sdk-|exporter-|instrumentation|resources|core|context-async-hooks)|@connectrpc\/)/;
const BROWSER_SOURCES = ['src/index.ts', ...SUBPATHS.map((spec) => spec.import.replace('./dist/', 'src/').replace('.mjs', '.ts'))];

describe('browser bundle', () => {
  it.each(BROWSER_SOURCES)('%s bundles for the browser with no server module or server package', async (entry) => {
    const result = await build({
      entryPoints: [join(PKG_ROOT, entry)],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
      external: ['react'],
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((input) => input.includes('src/server/'))).toEqual([]);
    expect(inputs.filter((input) => SERVER_PACKAGE.test(input))).toEqual([]);
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((i) => i.path));
    expect(imports.filter((path) => path !== 'react')).toEqual([]);
  });

  it('keeps the browser esbuild entry list and platform exactly as before; server entries build separately for node', () => {
    const { scripts } = readPackageJson();
    expect(scripts['build:esm']).toBe(
      'esbuild src/index.ts src/utils/trace.ts src/utils/sanitize.ts src/utils/logger.ts src/types/index.ts --bundle --splitting --format=esm --platform=neutral --packages=external --outbase=src --outdir=dist --out-extension:.js=.mjs --sourcemap',
    );
    expect(scripts['build:server']).toContain('--platform=node');
    const serverEntries = scripts['build:server'].split(' ').filter((part) => part.startsWith('src/'));
    expect(serverEntries.length).toBeGreaterThan(0);
    expect(serverEntries.every((part) => part.startsWith('src/server/'))).toBe(true);
    expect(scripts.build).toContain('npm run build:server');
  });

  it('leaves no server code in any browser output file under dist', () => {
    ensureBuilt();
    const offenders: string[] = [];
    for (const name of readdirSync(join(PKG_ROOT, 'dist'), { recursive: true }) as string[]) {
      if (name.startsWith('server') || !name.endsWith('.mjs')) continue;
      const source = readFileSync(join(PKG_ROOT, 'dist', name), 'utf8');
      if (/@opentelemetry\/(?:sdk-|exporter-|instrumentation)|@connectrpc\/|server\//.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  }, BUILD_BUDGET_MS);
});
