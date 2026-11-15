import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  GLOBALS_CSS,
  checkFiles,
  extractDefinitions,
  extractUses,
  readWebFiles,
  stripBlockComments,
} from './check-css-custom-properties.mjs';

const GLOBALS = `:root {\n  --space-2: 0.5rem;\n}\n[data-theme="navy"] {\n  --color-accent: #3498db;\n}\n`;

const files = (...extra) => [{ path: GLOBALS_CSS, text: GLOBALS }, ...extra];

test('stripBlockComments blanks comments but keeps their newlines', () => {
  const css = 'a {}\n/* one\n   two var(--x) */\nb { color: red; }';
  const stripped = stripBlockComments(css);
  assert.equal(stripped.split('\n').length, css.split('\n').length);
  assert.ok(!stripped.includes('var(--x)'));
});

test('extractDefinitions reads CSS declarations and TSX style keys', () => {
  assert.deepEqual(
    [...extractDefinitions('a.css', '.x { --status: var(--color-accent); color: var(--status); }')],
    ['--status'],
  );
  assert.deepEqual([...extractDefinitions('a.tsx', "<div style={{ '--progress': 0.5 }} />")], ['--progress']);
});

test('extractUses reports each use with its line, and skips CSS comments', () => {
  const css = '/* var(--color-status-…) */\n.a {\n  color: var( --color-accent, #000);\n}';
  assert.deepEqual(extractUses('a.css', css), [{ name: '--color-accent', path: 'a.css', line: 3 }]);
});

test('every use defined: no undefined uses, not vacuous', () => {
  const result = checkFiles(files({ path: 'apps/web/a.module.css', text: '.a { color: var(--color-accent); }' }));
  assert.deepEqual(result.undefinedUses, []);
  assert.deepEqual(result.vacuous, []);
});

test('known bad: an undefined property is flagged even with a fallback', () => {
  const css = '.a {\n  color: var(--color-primary, #2563eb);\n}';
  const { undefinedUses } = checkFiles(files({ path: 'apps/web/a.module.css', text: css }));
  assert.deepEqual(undefinedUses, [{ name: '--color-primary', path: 'apps/web/a.module.css', line: 2 }]);
});

test('TSX block comments are skipped; line comments are still read', () => {
  const tsx = "/* was var(--color-primary) */\n<a style={{ color: 'var(--color-accent)' }} />\n// var(--color-badge)";
  assert.deepEqual(extractUses('a.tsx', tsx).map((u) => [u.name, u.line]), [
    ['--color-accent', 2],
    ['--color-badge', 3],
  ]);
});

test('known bad: an undefined property in a TSX style string is flagged', () => {
  const tsx = "<a style={{ color: 'var(--color-primary, #0070f3)' }} />";
  const { undefinedUses } = checkFiles(files({ path: 'apps/web/page.tsx', text: tsx }));
  assert.deepEqual(undefinedUses.map((u) => u.name), ['--color-primary']);
});

test('a property defined in a TSX style object counts as defined', () => {
  const result = checkFiles(
    files(
      { path: 'apps/web/Bar.tsx', text: "<div style={{ '--fill': '40%' }} />" },
      { path: 'apps/web/Bar.module.css', text: '.bar { width: var(--fill); }' },
    ),
  );
  assert.deepEqual(result.undefinedUses, []);
});

test('vacuous: no files, or nothing read from globals.css', () => {
  assert.equal(checkFiles([]).vacuous.length, 4);
  const noGlobals = checkFiles([{ path: 'apps/web/a.module.css', text: '.a { --x: 1; width: var(--x); }' }]);
  assert.deepEqual(noGlobals.vacuous, [`${GLOBALS_CSS} was not read or defines nothing`]);
});

test('the real apps/web tree passes, and fails once an undefined use is added', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const real = readWebFiles(root);
  const clean = checkFiles(real);
  assert.deepEqual(clean.vacuous, []);
  assert.deepEqual(clean.undefinedUses, []);
  assert.ok(clean.definitions.has('--color-accent'));
  assert.ok(clean.uses.length > 100);

  const broken = real.map((file) =>
    file.path === GLOBALS_CSS ? { ...file, text: `${file.text}\nbody { color: var(--color-not-a-token, #000); }\n` } : file,
  );
  assert.deepEqual(
    checkFiles(broken).undefinedUses.map((u) => u.name),
    ['--color-not-a-token'],
  );
});
