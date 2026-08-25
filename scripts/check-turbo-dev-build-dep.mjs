#!/usr/bin/env node
/**
 * Validates that turbo.json's `dev` task depends on `^build`, so `turbo run dev`
 * builds each app's workspace libraries before starting either dev server.
 *
 * packages/core, packages/types and packages/api-client each resolve through
 * `"main": "dist/index.js"`, so the dev servers load the COMPILED dist, never the
 * TypeScript source. Without `^build` in dev's dependsOn, `npm run dev` serves
 * whatever dist happens to already be on disk — arbitrarily stale, with nothing
 * surfaced to say so. One checkout ran a seven-week-old packages/core that still
 * emitted a lift-import validation message #912 had already deleted, producing a
 * user-visible error current source cannot generate. See #944.
 *
 * Same class of gap as #496, which added `db:generate` to this task for Prisma.
 *
 * Usage: node scripts/check-turbo-dev-build-dep.mjs
 */

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/** Turborepo's topological dependency on every workspace dependency's `build` task. */
export const UPSTREAM_BUILD = '^build';

// --- Pure parsing helpers (exported for unit testing — see check-turbo-dev-build-dep.test.mjs) ---

/**
 * Removes `//` and block comments from a JSONC source string. turbo.json carries
 * explanatory comments (Turborepo accepts JSONC), so a bare JSON.parse throws on it.
 *
 * String literals are tracked so a `//` inside a value — e.g. the "$schema" URL on
 * turbo.json's first line — is never mistaken for a comment, and a backslash escape is
 * consumed as a pair so an escaped quote cannot end the string early. Newlines inside
 * comments are preserved so a JSON.parse error still reports a line number matching
 * the original file.
 */
export function stripJsonComments(source) {
  const BACKSLASH = String.fromCharCode(92);
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      } else if (ch === '\n') {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === BACKSLASH) {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  return out;
}

export function parseTurboConfig(source) {
  return JSON.parse(stripJsonComments(source));
}

/** The `dev` task's dependsOn array, or null when the task or the array is absent. */
export function getDevDependsOn(config) {
  const dev = config?.tasks?.dev;
  if (!dev || !Array.isArray(dev.dependsOn)) return null;
  return dev.dependsOn;
}

export function devDependsOnUpstreamBuild(config) {
  const dependsOn = getDevDependsOn(config);
  return dependsOn !== null && dependsOn.includes(UPSTREAM_BUILD);
}

function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..');
  const TURBO_JSON = resolve(root, 'turbo.json');

  if (!existsSync(TURBO_JSON)) {
    console.error(`ERROR: Expected file not found: ${TURBO_JSON}`);
    process.exit(1);
  }

  let config;
  try {
    config = parseTurboConfig(readFileSync(TURBO_JSON, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Could not parse ${TURBO_JSON}: ${err.message}`);
    process.exit(1);
  }

  const dependsOn = getDevDependsOn(config);
  if (dependsOn === null) {
    console.error('ERROR: turbo.json has no tasks.dev.dependsOn array.');
    console.error(`Add one that includes "${UPSTREAM_BUILD}" so dev builds workspace libraries first.`);
    process.exit(1);
  }

  if (!dependsOn.includes(UPSTREAM_BUILD)) {
    console.error(`ERROR: turbo.json's "dev" task does not depend on "${UPSTREAM_BUILD}".`);
    console.error(`  tasks.dev.dependsOn = ${JSON.stringify(dependsOn)}`);
    console.error('');
    console.error('packages/core, packages/types and packages/api-client resolve through');
    console.error('"main": "dist/index.js", so the dev servers load the compiled dist, not the');
    console.error(`TypeScript source. Without "${UPSTREAM_BUILD}", \`npm run dev\` serves whatever dist is`);
    console.error('already on disk — arbitrarily stale, with nothing surfaced to say so (#944).');
    console.error('');
    console.error(`Fix: add "${UPSTREAM_BUILD}" to tasks.dev.dependsOn in turbo.json.`);
    process.exit(1);
  }

  console.log(`OK: turbo.json's "dev" task depends on "${UPSTREAM_BUILD}" (${JSON.stringify(dependsOn)}).`);
  process.exit(0);
}

// Only run when executed directly — lets check-turbo-dev-build-dep.test.mjs import the
// pure helpers above without triggering a real filesystem read + process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
