module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  setupFilesAfterEnv: ['jest-extended/all', '<rootDir>/tests/setup.ts'],
  transform: {
    // Also transform .js/.mjs so MSW v2's ESM-only dependencies (rettime,
    // @mswjs/interceptors, etc.) are converted to CommonJS for the node test env.
    '^.+\\.(ts|tsx|mjs|js|cjs)$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
      diagnostics: {
        warnOnly: true
      }
    }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(msw|@mswjs|@open-draft|@bundled-es-modules|until-async|rettime|strict-event-emitter|headers-polyfill|outvariant|is-node-process|tough-cookie|graphql)/)'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/types/index.ts'
  ],
  // Coverage gate (testing doctrine §5): the org 85% target across all four
  // metrics. The suite currently sits well above this (branches ~88, lines ~98),
  // so 85 is a one-way floor that can only ratchet up, never down.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 85,
      functions: 85,
      lines: 85,
    },
  },
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,
};
