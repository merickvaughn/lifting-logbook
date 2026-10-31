#!/usr/bin/env node
/**
 * Validates that turbo.json's `lint` and `build` inputs cover every file those tasks
 * actually read, so a change to a file outside the inputs can never get a cache hit.
 *
 * When a task declares `inputs`, Turborepo hashes ONLY the files those globs match. A
 * source file outside them is invisible to the hash: changing it replays the cached
 * result, and CI reports success for a lint or build that never ran. apps/web keeps
 * real source in lib/ and components/, but neither directory was in `build.inputs` or
 * `lint.inputs`, so a lib/- or components/-only change silently skipped web's lint and
 * could restore a stale `.next`. See #845.
 *
 * The files each task reads are derived from the repository, not from a list kept here:
 *
 *   lint  — every tracked file under the paths the workspace's own `eslint <paths>`
 *           script lints. Widening the lint script widens what must be covered.
 *   build — every tracked source file in a workspace that has a `build` script, minus
 *           the files no build reads (tests, and configs consumed only by test, lint or
 *           typecheck). See NOT_BUILD_INPUTS.
 *
 * Usage: node scripts/check-turbo-task-inputs.mjs
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, posix, resolve } from 'path';

import { parseTurboConfig } from './check-turbo-dev-build-dep.mjs';

/** Turborepo microsyntax: a glob anchored at the repo root instead of the workspace. */
export const TURBO_ROOT = '$TURBO_ROOT$/';
/** Turborepo microsyntax: splice the inherited inputs into a package-level override. */
export const TURBO_EXTENDS = '$TURBO_EXTENDS$';

/** Extensions ESLint lints under the flat config (JavaScript and TypeScript only). */
const LINT_EXTENSION = /\.[cm]?[jt]sx?$/;
/** Extensions the TypeScript, Next and Nest builds read: code, CSS modules and JSON config. */
const BUILD_EXTENSION = /\.(?:[cm]?[jt]sx?|css|json)$/;

/**
 * Tracked source files that no `build` task reads, as workspace-relative globs (or
 * repo-root-relative ones prefixed with TURBO_ROOT). Everything else with a source
 * extension in a workspace that has a `build` script must be a build input.
 */
export const NOT_BUILD_INPUTS = [
  // Tests and their fixtures/mocks — the `test` and `typecheck` tasks read these.
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  'tests/**',
  'e2e/**',
  // Tool configs read by test, lint, typecheck or e2e — never by a build.
  'jest.*',
  'playwright.config*',
  'eslint.config.*',
  'tsconfig.spec.json',
  'tsconfig.typecheck.json',
  // Turborepo's own per-package config; Turborepo folds it into every task hash itself.
  'turbo.json',
  // apps/api: operator scripts outside tsconfig.build.json's src/** include, and Prisma
  // files owned by `db:generate` (which `build` depends on) and the Prisma CLI.
  `${TURBO_ROOT}apps/api/scripts/**`,
  `${TURBO_ROOT}apps/api/prisma/**`,
];

// --- Pure helpers (exported for unit testing — see check-turbo-task-inputs.test.mjs) ---

/** Converts one Turborepo input glob (`*`, `**`, `?`) to an anchored RegExp. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Resolves a workspace-relative or TURBO_ROOT glob to a repo-root-relative glob. */
export function toRootGlob(glob, workspaceDir) {
  if (glob.startsWith(TURBO_ROOT)) return glob.slice(TURBO_ROOT.length);
  return posix.normalize(posix.join(workspaceDir, glob));
}

/**
 * Builds a matcher for root-relative file paths from Turborepo inputs: a file is an
 * input when it matches at least one positive glob and no `!` glob.
 */
export function inputsMatcher(globs, workspaceDir) {
  const include = [];
  const exclude = [];
  for (const glob of globs) {
    if (glob.startsWith('!')) exclude.push(globToRegExp(toRootGlob(glob.slice(1), workspaceDir)));
    else include.push(globToRegExp(toRootGlob(glob, workspaceDir)));
  }
  return (file) => include.some((re) => re.test(file)) && !exclude.some((re) => re.test(file));
}

/**
 * The inputs Turborepo uses for `task` in a workspace, or null when none are declared
 * (Turborepo then hashes every tracked file in the package, which covers everything).
 * Precedence matches Turborepo: a root `<pkg>#<task>` entry, then the workspace's own
 * turbo.json, then the root task.
 */
export function effectiveInputs(rootConfig, packageConfig, packageName, task) {
  const rootInputs = rootConfig?.tasks?.[task]?.inputs ?? null;
  const pinned = rootConfig?.tasks?.[`${packageName}#${task}`];
  if (pinned) return pinned.inputs ?? null;
  const override = packageConfig?.tasks?.[task]?.inputs;
  if (override === undefined) return rootInputs;
  if (!override.includes(TURBO_EXTENDS)) return override;
  return [...(rootInputs ?? []), ...override.filter((glob) => glob !== TURBO_EXTENDS)];
}

/**
 * The paths a workspace lint script hands to ESLint, or null when the script does not
 * run ESLint at all (e.g. tools/eslint-rules' `echo ... && exit 0`). Throws on a shape
 * this guard cannot read, so a new form fails loudly instead of passing unchecked.
 */
export function eslintPaths(lintScript) {
  if (typeof lintScript !== 'string' || !/^eslint(?:\s|$)/.test(lintScript)) return null;
  const args = lintScript.trim().split(/\s+/).slice(1);
  if (args.length === 0 || args.some((arg) => arg.startsWith('-') || /[&|;<>]/.test(arg))) {
    throw new Error(`Unsupported lint script shape: "${lintScript}". Expected "eslint <path>...".`);
  }
  return args.map((arg) => posix.normalize(arg).replace(/\/$/, ''));
}

/** Tracked files (root-relative) a workspace's lint script hands to ESLint. */
export function lintedFiles(workspaceFiles, workspaceDir, paths) {
  const roots = paths.map((p) => (p === '.' ? workspaceDir : posix.join(workspaceDir, p)));
  return workspaceFiles.filter(
    (file) => LINT_EXTENSION.test(file) && roots.some((root) => file === root || file.startsWith(`${root}/`)),
  );
}

/** Tracked source files (root-relative) a workspace's build reads. */
export function builtFiles(workspaceFiles, workspaceDir) {
  const notBuilt = inputsMatcher(NOT_BUILD_INPUTS, workspaceDir);
  return workspaceFiles.filter(
    (file) => BUILD_EXTENSION.test(file) && file !== `${workspaceDir}/package.json` && !notBuilt(file),
  );
}

/** Files from `files` that the task's inputs miss; empty when inputs are undeclared. */
export function uncovered(files, inputs, workspaceDir) {
  if (inputs === null) return [];
  const isInput = inputsMatcher(inputs, workspaceDir);
  return files.filter((file) => !isInput(file));
}

function readJson(path) {
  return parseTurboConfig(readFileSync(path, 'utf8'));
}

function workspaceDirs(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) throw new Error(`Unsupported workspaces pattern "${pattern}".`);
    const parent = pattern.slice(0, -2);
    const listed = execFileSync('git', ['ls-files', '-z', '--', `${parent}/*/package.json`], { cwd: root })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    dirs.push(...listed.map((file) => posix.dirname(file)));
  }
  return dirs;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const turboJson = resolve(root, 'turbo.json');
  if (!existsSync(turboJson)) {
    console.error(`ERROR: Expected file not found: ${turboJson}`);
    process.exit(1);
  }

  const rootConfig = readJson(turboJson);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  const problems = [];
  const checked = [];

  for (const dir of workspaceDirs(root, readJson(resolve(root, 'package.json')).workspaces)) {
    const pkg = readJson(resolve(root, dir, 'package.json'));
    const packageTurbo = resolve(root, dir, 'turbo.json');
    const packageConfig = existsSync(packageTurbo) ? readJson(packageTurbo) : null;
    const files = tracked.filter((file) => file.startsWith(`${dir}/`));

    const paths = eslintPaths(pkg.scripts?.lint);
    if (paths) {
      const inputs = effectiveInputs(rootConfig, packageConfig, pkg.name, 'lint');
      const linted = lintedFiles(files, dir, paths);
      if (linted.length === 0) problems.push(`${pkg.name} lint: "${pkg.scripts.lint}" matched no tracked files.`);
      for (const file of uncovered(linted, inputs, dir)) problems.push(`${pkg.name} lint: ${file}`);
      checked.push(`${pkg.name} lint (${linted.length} files)`);
    }

    if (pkg.scripts?.build) {
      const inputs = effectiveInputs(rootConfig, packageConfig, pkg.name, 'build');
      const built = builtFiles(files, dir);
      if (built.length === 0) problems.push(`${pkg.name} build: found no tracked source files.`);
      for (const file of uncovered(built, inputs, dir)) problems.push(`${pkg.name} build: ${file}`);
      checked.push(`${pkg.name} build (${built.length} files)`);
    }
  }

  if (problems.length > 0) {
    console.error('ERROR: turbo.json task inputs miss files those tasks read.');
    console.error('A change to any file below gets a Turborepo cache hit, so CI replays the');
    console.error('cached result and the task silently never runs on it (#845):');
    console.error('');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('');
    console.error('Fix: add a glob covering each file to that task\'s "inputs" in turbo.json. If a');
    console.error('build-flagged file is genuinely never read by a build, add it to NOT_BUILD_INPUTS');
    console.error('in scripts/check-turbo-task-inputs.mjs with the reason.');
    process.exit(1);
  }

  console.log(`OK: turbo.json inputs cover every file read by ${checked.join(', ')}.`);
  process.exit(0);
}

// Only run when executed directly — lets check-turbo-task-inputs.test.mjs import the
// pure helpers above without triggering a real git read + process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
