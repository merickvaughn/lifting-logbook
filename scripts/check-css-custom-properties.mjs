#!/usr/bin/env node
/**
 * Fails when apps/web refers to a CSS custom property that nothing defines (#1064).
 *
 * `var(--x, fallback)` with an undefined `--x` doesn't break anything visibly: the browser uses
 * the fallback, the page renders and every test passes. But the fallback is a fixed value, so the
 * rule ignores the active theme (`navy` / `iron`). Without a fallback, the property silently
 * becomes its initial value, which is how #1062's `--color-accent-text` left text unstyled.
 * #1064 found eight more such tokens, used 52 times between them.
 *
 * What it reads, from the files git tracks under apps/web:
 *
 *   - Definitions: every `--name:` declaration in a `.css` file, plus every `'--name':` key in a
 *     `.ts`/`.tsx` file (a property set from a React `style` object).
 *   - Uses: every `var(--name` in a `.css`, `.ts` or `.tsx` file.
 *
 * Block comments are stripped first, so a comment that mentions `var(--color-status-…)` isn't
 * read as a use. `//` line comments in TS/TSX are still read: stripping them safely would need a
 * tokenizer, since `//` also appears inside strings such as URLs. A property defined anywhere
 * counts as defined everywhere: the guard doesn't model which selector a declaration sits under.
 *
 * It refuses to pass vacuously: if it finds no stylesheets, no definitions, no uses, or nothing
 * defined in apps/web/app/globals.css, it fails rather than report a clean result.
 *
 * Usage: node scripts/check-css-custom-properties.mjs
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

export const WEB_ROOT = 'apps/web';
export const GLOBALS_CSS = 'apps/web/app/globals.css';

const SCANNED = /\.(css|tsx?)$/;

/** Removes `/* … *\/` comments, keeping newlines so reported line numbers stay right. */
export function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** The custom properties a file defines. */
export function extractDefinitions(path, text) {
  const pattern = path.endsWith('.css') ? /(?:^|[{;\s])(--[\w-]+)\s*:/g : /['"](--[\w-]+)['"]\s*:/g;
  return new Set([...stripBlockComments(text).matchAll(pattern)].map((m) => m[1]));
}

/** Every `var(--name` in a file, with its line number. */
export function extractUses(path, text) {
  const source = stripBlockComments(text);
  return [...source.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => ({
    name: m[1],
    path,
    line: lineAt(source, m.index),
  }));
}

/**
 * Checks a set of files, each `{ path, text }`. Returns the properties defined, the uses found,
 * the uses of an undefined property, and any reason the result would be vacuous.
 */
export function checkFiles(files) {
  const definitions = new Set();
  const uses = [];
  let globalsDefinitions = 0;
  for (const { path, text } of files) {
    const defined = extractDefinitions(path, text);
    defined.forEach((name) => definitions.add(name));
    if (path === GLOBALS_CSS) globalsDefinitions = defined.size;
    uses.push(...extractUses(path, text));
  }

  const vacuous = [];
  if (!files.some(({ path }) => path.endsWith('.css'))) vacuous.push('no .css files were found');
  if (definitions.size === 0) vacuous.push('no custom property definitions were found');
  if (uses.length === 0) vacuous.push('no var(--…) uses were found');
  if (globalsDefinitions === 0) vacuous.push(`${GLOBALS_CSS} was not read or defines nothing`);

  return {
    definitions,
    uses,
    undefinedUses: uses.filter((use) => !definitions.has(use.name)),
    vacuous,
  };
}

/** The tracked .css/.ts/.tsx files under apps/web, read from disk. */
export function readWebFiles(repoRoot) {
  return execFileSync('git', ['ls-files', '-z', '--', WEB_ROOT], { cwd: repoRoot })
    .toString('utf8')
    .split('\0')
    .filter((path) => SCANNED.test(path))
    .map((path) => ({ path, text: readFileSync(resolve(repoRoot, path), 'utf8') }));
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { definitions, uses, undefinedUses, vacuous } = checkFiles(readWebFiles(repoRoot));

  if (vacuous.length > 0) {
    console.error(
      [
        'FAIL: the custom-property scan found nothing to check, so a pass would mean nothing:',
        ...vacuous.map((reason) => `  ${reason}`),
      ].join('\n'),
    );
    process.exit(1);
  }

  if (undefinedUses.length > 0) {
    const names = [...new Set(undefinedUses.map((use) => use.name))].sort();
    console.error(
      [
        `FAIL: ${undefinedUses.length} var() use(s) name a custom property nothing in ${WEB_ROOT} defines:\n`,
        ...undefinedUses.map(({ name, path, line }) => `  ${path}:${line}  ${name}`),
        `\nUndefined: ${names.join(', ')}.`,
        `Point each use at an existing token in ${GLOBALS_CSS}, or define the token in every theme`,
        'block there. A fallback in var(--x, fallback) does not count: it ignores the theme. See #1064.',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log(`OK: all ${uses.length} var() uses in ${WEB_ROOT} name one of ${definitions.size} defined custom properties.`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
