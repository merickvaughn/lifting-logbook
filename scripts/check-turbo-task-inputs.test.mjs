import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  TURBO_EXTENDS,
  globToRegExp,
  toRootGlob,
  inputsMatcher,
  effectiveInputs,
  eslintPaths,
  lintedFiles,
  builtFiles,
  uncovered,
} from './check-turbo-task-inputs.mjs';
import { parseTurboConfig } from './check-turbo-dev-build-dep.mjs';

const WEB = 'apps/web';

// The lint/build inputs exactly as they stood before #845 — the known-bad reference.
const PRE_845_LINT = ['src/**', 'app/**', 'scripts/**', '*.ts', '.eslintrc*', 'eslint.config*'];
const PRE_845_BUILD = [
  'src/**', 'app/**', '!src/**/*.test.ts', '!src/**/*.spec.ts', '!src/**/__tests__/**',
  'tsconfig.json', 'package.json', 'next.config.*',
];

test('globToRegExp: ** spans directories, * stays within one segment', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/**/*.test.ts').test('src/x.test.ts'));
  assert.ok(globToRegExp('src/**/*.test.ts').test('src/a/b/x.test.ts'));
  assert.ok(globToRegExp('*.ts').test('middleware.ts'));
  assert.ok(!globToRegExp('*.ts').test('lib/api.ts'));
  assert.ok(globToRegExp('next.config.*').test('next.config.ts'));
  assert.ok(!globToRegExp('next.config.*').test('nextXconfig.ts'), 'a literal dot must not match any character');
});

test('toRootGlob resolves workspace-relative, ../ and $TURBO_ROOT$ globs to the repo root', () => {
  assert.equal(toRootGlob('lib/**', WEB), 'apps/web/lib/**');
  assert.equal(toRootGlob('../../package-lock.json', WEB), 'package-lock.json');
  assert.equal(toRootGlob('$TURBO_ROOT$/eslint.config.js', WEB), 'eslint.config.js');
});

test('inputsMatcher applies ! globs after the positive ones', () => {
  const isInput = inputsMatcher(PRE_845_BUILD, 'packages/core');
  assert.ok(isInput('packages/core/src/index.ts'));
  assert.ok(!isInput('packages/core/src/index.test.ts'));
  assert.ok(!isInput('packages/core/src/__tests__/x.ts'));
});

test('effectiveInputs: root task, package override, $TURBO_EXTENDS$, <pkg>#<task>, undeclared', () => {
  const root = { tasks: { lint: { inputs: ['src/**'] }, build: {} } };
  assert.deepEqual(effectiveInputs(root, null, 'p', 'lint'), ['src/**']);
  assert.equal(effectiveInputs(root, null, 'p', 'build'), null);
  assert.deepEqual(effectiveInputs(root, { tasks: { lint: { inputs: ['x/**'] } } }, 'p', 'lint'), ['x/**']);
  assert.deepEqual(
    effectiveInputs(root, { tasks: { lint: { inputs: [TURBO_EXTENDS, 'x/**'] } } }, 'p', 'lint'),
    ['src/**', 'x/**'],
  );
  // apps/web's real turbo.json overrides only test, so lint falls through to the root.
  assert.deepEqual(effectiveInputs(root, { tasks: { test: { dependsOn: [] } } }, 'p', 'lint'), ['src/**']);
  const pinned = { tasks: { ...root.tasks, 'p#lint': { inputs: ['y/**'] } } };
  assert.deepEqual(effectiveInputs(pinned, { tasks: { lint: { inputs: ['x/**'] } } }, 'p', 'lint'), ['y/**']);
});

test('eslintPaths reads eslint <paths>, skips non-eslint scripts, rejects unreadable shapes', () => {
  assert.deepEqual(eslintPaths('eslint app lib components'), ['app', 'lib', 'components']);
  assert.deepEqual(eslintPaths('eslint .'), ['.']);
  assert.deepEqual(eslintPaths('eslint src/'), ['src']);
  assert.equal(eslintPaths('echo "(no lint)" && exit 0'), null);
  assert.equal(eslintPaths(undefined), null);
  assert.throws(() => eslintPaths('eslint --ext .ts src'), /Unsupported lint script shape/);
  assert.throws(() => eslintPaths('eslint src && tsc'), /Unsupported lint script shape/);
  assert.throws(() => eslintPaths('eslint'), /Unsupported lint script shape/);
});

test('lintedFiles keeps JS/TS files under the linted paths only', () => {
  const files = ['apps/web/lib/api.ts', 'apps/web/library/x.ts', 'apps/web/app/a.module.css', 'apps/web/middleware.ts'];
  assert.deepEqual(lintedFiles(files, WEB, ['lib']), ['apps/web/lib/api.ts']);
  assert.deepEqual(lintedFiles(['apps/mobile/App.tsx', 'apps/mobile/app.json'], 'apps/mobile', ['.']), ['apps/mobile/App.tsx']);
});

test('builtFiles drops tests, tool configs and NOT_BUILD_INPUTS paths', () => {
  const files = [
    'apps/web/lib/api.ts',
    'apps/web/components/X.module.css',
    'apps/web/lib/__tests__/api.test.ts',
    'apps/web/e2e/smoke.spec.ts',
    'apps/web/jest.config.js',
    'apps/web/tsconfig.typecheck.json',
    'apps/web/turbo.json',
    'apps/web/package.json',
    'apps/web/README.md',
  ];
  assert.deepEqual(builtFiles(files, WEB), ['apps/web/lib/api.ts', 'apps/web/components/X.module.css']);
  assert.deepEqual(builtFiles(['apps/api/scripts/seed.ts', 'apps/api/nest-cli.json'], 'apps/api'), ['apps/api/nest-cli.json']);
});

test('uncovered is empty when inputs are undeclared (Turborepo then hashes every file)', () => {
  assert.deepEqual(uncovered(['apps/web/lib/api.ts'], null, WEB), []);
});

// Calibration: the known-bad pre-#845 inputs must be caught, the known-good current ones pass.

test('known-bad: pre-#845 inputs miss web lib/ for lint and lib/ + components/ for build', () => {
  const lint = uncovered(lintedFiles(['apps/web/lib/api.ts', 'apps/web/app/page.tsx'], WEB, ['app', 'lib']), PRE_845_LINT, WEB);
  assert.deepEqual(lint, ['apps/web/lib/api.ts']);
  const build = uncovered(
    builtFiles(['apps/web/lib/api.ts', 'apps/web/components/X.tsx', 'apps/web/app/page.tsx'], WEB),
    PRE_845_BUILD,
    WEB,
  );
  assert.deepEqual(build, ['apps/web/lib/api.ts', 'apps/web/components/X.tsx']);
});

test('known-good: the real turbo.json covers web lib/, components/ and root source', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = parseTurboConfig(readFileSync(resolve(root, 'turbo.json'), 'utf8'));
  const files = [
    'apps/web/lib/api.ts', 'apps/web/components/X.tsx', 'apps/web/components/X.module.css',
    'apps/web/middleware.ts', 'apps/web/instrumentation.ts', 'apps/web/app/page.tsx',
  ];
  const lintInputs = effectiveInputs(config, null, '@lifting-logbook/web', 'lint');
  const buildInputs = effectiveInputs(config, null, '@lifting-logbook/web', 'build');
  assert.deepEqual(uncovered(lintedFiles(files, WEB, ['app', 'lib', 'components']), lintInputs, WEB), []);
  assert.deepEqual(uncovered(builtFiles(files, WEB), buildInputs, WEB), []);
});
