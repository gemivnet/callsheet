import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  maxWorkers: '50%',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  collectCoverageFrom: [
    'src/**/*.ts',
    'src/**/*.tsx',
    '!src/cli.ts',
    '!src/**/*.test.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 84,
      functions: 95,
      lines: 95,
    },
  },
  // ts-jest + ESM + googleapis occasionally leaves workers dangling after all
  // tests pass, causing Jest to exit(1) with "worker failed to exit
  // gracefully". All assertions have already run — force-exit to keep CI green.
  forceExit: true,
};

export default config;
