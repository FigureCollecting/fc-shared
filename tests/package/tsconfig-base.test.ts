/**
 * fc-shared is the estate's BOM anchor, but a baseline nobody can `extends` is
 * a convention rather than a mechanism. 1.7.0 ships `tsconfig.base.json` and
 * makes this repo consume it too, so drift is impossible by construction.
 *
 * The regression guard that matters is the RESOLVED config: extracting options
 * into a base file must not change a single effective compiler option.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_ROOT, runTsc } from './package-contract';

/** Options the baseline owns, as TypeScript resolves them (lowercased enums). */
const BASELINE_RESOLVED = {
  target: 'es2022',
  module: 'esnext',
  moduleResolution: 'bundler',
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
};

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PKG_ROOT, file), 'utf8')) as Record<string, unknown>;
}

function resolvedOptions(project: string): Record<string, unknown> {
  const shown = JSON.parse(runTsc(['-p', project, '--showConfig'])) as {
    compilerOptions: Record<string, unknown>;
  };
  return shown.compilerOptions;
}

describe('shippable tsconfig baseline', () => {
  it('is plain JSON, so a consumer parsing it without a JSONC reader succeeds', () => {
    const raw = readFileSync(join(PKG_ROOT, 'tsconfig.base.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('carries target, module resolution and strictness', () => {
    const base = readJson('tsconfig.base.json') as { compilerOptions: Record<string, unknown> };
    expect(base.compilerOptions).toMatchObject({
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
    });
  });

  it("the repo's own tsconfig inherits it rather than restating it", () => {
    const own = readJson('tsconfig.json') as {
      extends?: string;
      compilerOptions?: Record<string, unknown>;
    };
    expect(own.extends).toBe('./tsconfig.base.json');
    const restated = Object.keys(BASELINE_RESOLVED).filter(
      (option) => own.compilerOptions?.[option] !== undefined
    );
    expect(restated).toEqual([]);
  });

  it('leaves the resolved development config byte-for-byte equivalent', () => {
    expect(resolvedOptions('tsconfig.json')).toEqual({
      ...BASELINE_RESOLVED,
      declaration: true,
      declarationMap: true,
      jsx: 'react-jsx',
      types: ['node', 'jest'],
    });
  });

  it('leaves the resolved build config byte-for-byte equivalent', () => {
    expect(resolvedOptions('tsconfig.build.json')).toEqual({
      ...BASELINE_RESOLVED,
      module: 'commonjs',
      declaration: true,
      declarationMap: true,
      jsx: 'react-jsx',
      types: ['node'],
      outDir: './dist',
      rootDir: './src',
    });
  });

  it('leaves the resolved test config byte-for-byte equivalent', () => {
    expect(resolvedOptions('tsconfig.test.json')).toEqual({
      ...BASELINE_RESOLVED,
      module: 'commonjs',
      declaration: true,
      declarationMap: true,
      isolatedModules: true,
      preserveConstEnums: true,
      jsx: 'react-jsx',
      types: ['jest', 'node'],
    });
  });
});
