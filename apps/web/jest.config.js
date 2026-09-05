const base = require('../../jest.config.base.js');

// #807: apps/web suites load jsdom + React + the full @lifting-logbook/core barrel,
// so each Jest worker's footprint is much larger than packages/core's. Under a full
// `npm test -w @lifting-logbook/web` parallel run on Windows, several such workers
// accumulate heap and one can OOM at load — most visibly the CSV-heavy onboarding
// suites (StepImport/StepLifts). jest.config.base.js gates its worker-memory
// mitigation to Node >= 24 (transpile-only ts-jest, #651, stopped packages/core from
// OOMing on Node 20/22), but web is heavy enough to OOM on Node 20 too. Re-apply the
// same #419 pair here for EVERY win32 Node: cap parallelism at 50% of CPUs and recycle
// any worker whose RSS passes 512 MB before it picks up the next file. Base's win32
// `testTimeout` is preserved (spread first); Linux CI is unaffected (not win32).
const webWin32Memory =
  process.platform === 'win32'
    ? { workerIdleMemoryLimit: '512MB', maxWorkers: '50%' }
    : {};

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...base,
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: [...(base.setupFilesAfterEnv ?? []), '<rootDir>/jest.setup.ts'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  transform: {
    // ts-jest runs transpile-only here: tsconfig.spec.json sets isolatedModules, so
    // each test file is transpiled without type-checking (fast — see issue #651).
    // This also sidesteps the #421 @testing-library/jest-dom matcher-augmentation
    // type error (previously softened with diagnostics.warnOnly): transpile-only emits
    // no type diagnostics from the test run at all. Tests still run and pass at runtime
    // (jest.setup.ts loads jest-dom).
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '\\.module\\.css$': 'identity-obj-proxy',
    '^@src/core$': '<rootDir>/../../packages/core/src/index.ts',
    '^@src/core/(.*)$': '<rootDir>/../../packages/core/src/$1',
    '^@lifting-logbook/api-client$': '<rootDir>/../../packages/api-client/src/index.ts',
    '^@lifting-logbook/core$': '<rootDir>/../../packages/core/src/index.ts',
    '^@lifting-logbook/types$': '<rootDir>/../../packages/types/src/index.ts',
    '^@/(.*)$': '<rootDir>/$1',
    // `server-only` throws under Jest; stubbed so server-side lib modules
    // (lib/loadWorkoutPlan.ts, lib/preferences.ts) can be tested directly.
    '^server-only$': '<rootDir>/__mocks__/server-only.js',
  },
  // win32-only worker-memory mitigation (#807); spread last so it applies on every
  // win32 Node without disturbing base's win32 testTimeout. No-op off win32.
  ...webWin32Memory,
};
