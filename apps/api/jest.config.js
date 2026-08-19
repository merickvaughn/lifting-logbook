// apps/api's two heaviest specs (programs.e2e.spec.ts and programs.db.e2e.spec.ts,
// 1700+ / 1400+ lines) each bootstrap a full NestJS + Fastify app; under a full
// `npm test -w @lifting-logbook/api` parallel run on Windows, their workers can
// accumulate enough heap to OOM at load — observed directly while adding the
// body-weight DB-e2e coverage in #904 (both crashed with "Jest worker ran out
// of memory" while every one of the other 45 suites, and both files run in
// isolation, passed cleanly). This is the same failure class already fixed for
// packages/core (#419) and apps/web (#807); apps/api's config is standalone
// (does not extend jest.config.base.js — see CLAUDE.md), so re-apply the same
// #419 pair directly here for every win32 Node: cap parallelism at 50% of CPUs
// and recycle any worker whose RSS passes 512 MB before it picks up the next
// file. Linux CI is unaffected (not win32).
const apiWin32Memory =
  process.platform === 'win32'
    ? { workerIdleMemoryLimit: '512MB', maxWorkers: '50%' }
    : {};

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.env.setup.js'],
  globalSetup: '<rootDir>/jest.global-setup.js',
  globalTeardown: '<rootDir>/jest.global-teardown.js',
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  transformIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    // Map workspace packages to their TypeScript source so tests always see
    // the in-tree version rather than the compiled dist in the root node_modules
    // (which is shared with the main checkout and may be stale in a worktree).
    '^@lifting-logbook/core$': '<rootDir>/../../packages/core/src/index.ts',
    '^@lifting-logbook/types$': '<rootDir>/../../packages/types/src/index.ts',
    // @src/core is a path alias used internally inside packages/core sources.
    '^@src/core$': '<rootDir>/../../packages/core/src/index.ts',
    '^@src/core/(.*)$': '<rootDir>/../../packages/core/src/$1',
  },
  // win32-only worker-memory mitigation (#904); no-op off win32.
  ...apiWin32Memory,
};
