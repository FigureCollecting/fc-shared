/**
 * What actually reaches a consumer. `files: ["dist"]` is easy to get wrong in
 * both directions: a shipped baseline that is not packed cannot be extended,
 * and an ESM entry point whose shared chunk is missing fails at import time in
 * the consumer rather than here.
 */
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { LOG_SCHEMA_FILE, PKG_ROOT, SERVER_SUBPATHS, SUBPATHS, ensureBuilt, runNpm } from './package-contract';

const PACK_BUDGET_MS = 600_000;

/** Relative specifiers of sibling ESM modules an esbuild output depends on. */
function esmDependencies(distRelativeFile: string): string[] {
  const source = readFileSync(join(PKG_ROOT, distRelativeFile), 'utf8');
  const matches = source.matchAll(/["'](\.\.?\/[^"']+\.mjs)["']/g);
  const here = posix.dirname(distRelativeFile);
  return [...new Set([...matches].map((match) => posix.normalize(posix.join(here, match[1]))))];
}

describe('published tarball contents', () => {
  let packed: string[];

  beforeAll(() => {
    ensureBuilt();
    const report = JSON.parse(runNpm(['pack', '--dry-run', '--json'])) as Array<{
      files: Array<{ path: string }>;
    }>;
    packed = report[0].files.map((file) => file.path);
  }, PACK_BUDGET_MS);

  it('packs the shippable tsconfig baseline', () => {
    expect(packed).toContain('tsconfig.base.json');
  });

  it.each(SUBPATHS.map((spec) => [spec.subpath, spec] as const))(
    '%s: packs every file its exports entry points at',
    (_subpath, spec) => {
      for (const target of [spec.types, spec.import, spec.require]) {
        expect({ target, packed: packed.includes(target.replace('./', '')) }).toEqual({
          target,
          packed: true,
        });
      }
    }
  );

  it('packs the shared ESM chunks the subpath entry points import', () => {
    // Splitting is what keeps module state single-instance; the chunks it emits
    // are load-bearing files, not build scratch.
    const missing: string[] = [];
    for (const spec of SUBPATHS) {
      const entry = spec.import.replace('./', '');
      for (const dependency of esmDependencies(entry)) {
        if (!packed.includes(dependency)) missing.push(dependency);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each(SERVER_SUBPATHS.map((spec) => [spec.subpath, spec] as const))(
    '%s: packs its entry points and every server chunk they import',
    (_subpath, spec) => {
      for (const target of [spec.types, spec.import, spec.require]) {
        expect({ target, packed: packed.includes(target.replace('./', '')) }).toEqual({ target, packed: true });
      }
      const missing = esmDependencies(spec.import.replace('./', '')).filter((dep) => !packed.includes(dep));
      expect(missing).toEqual([]);
    }
  );

  it('packs the log-shape schema', () => {
    expect(packed).toContain(LOG_SCHEMA_FILE.replace('./', ''));
  });

  it('still packs the root barrel entry points', () => {
    for (const file of ['dist/index.js', 'dist/index.mjs', 'dist/index.d.ts']) {
      expect(packed).toContain(file);
    }
  });
});
