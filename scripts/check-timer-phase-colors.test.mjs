import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  DIAL_PHASES,
  declaredThemeNames,
  extractThemeBlocks,
  findConflicts,
  readDialTokens,
  readPhaseColors,
} from './check-timer-phase-colors.mjs';

// A trimmed stand-in for globals.css carrying only what the guard reads. Shaped
// like the real file: a `:root, [data-theme="navy"]` pair plus a standalone
// `[data-theme="iron"]` block.
const GOOD_CSS = `
:root {
  --space-1: 0.25rem;
}

:root,
[data-theme="navy"] {
  --color-accent: #3498db;
  --color-rest: #27ae60;
  --color-prep: #e0a800;
  --color-error-text: #c0392b;
}

[data-theme="iron"] {
  --color-accent: #22c55e;
  --color-rest: #0284c7;
  --color-prep: #d97706;
  --color-error-text: #dc2626;
}
`;

// The dial stylesheet the guard derives its phase -> token map from.
const GOOD_DIAL = `
.track { fill: none; stroke: var(--color-surface-alt); }
.fill { fill: none; stroke-linecap: round; }
.set { stroke: var(--color-accent); }
.rest { stroke: var(--color-rest); }
.prep { stroke: var(--color-prep); }
.overrun { stroke: var(--color-error-text); }
`;

const TOKENS = readDialTokens(GOOD_DIAL).tokens;

test('extractThemeBlocks finds every named theme', () => {
  const blocks = extractThemeBlocks(GOOD_CSS);
  assert.deepEqual(Object.keys(blocks).sort(), ['iron', 'navy']);
});

test('extractThemeBlocks handles a theme paired with :root in one selector', () => {
  const blocks = extractThemeBlocks(GOOD_CSS);
  assert.match(blocks.navy, /--color-accent: #3498db;/);
});

test('extractThemeBlocks returns nothing for CSS with no themes', () => {
  assert.deepEqual(extractThemeBlocks(':root { --space-1: 0.25rem; }'), {});
});

test('readPhaseColors reads all four phases', () => {
  const colors = readPhaseColors(extractThemeBlocks(GOOD_CSS).iron, TOKENS);
  assert.deepEqual(colors, {
    set: '#22c55e',
    rest: '#0284c7',
    prep: '#d97706',
    overrun: '#dc2626',
  });
});

test('readPhaseColors reports an absent token as null rather than guessing', () => {
  const colors = readPhaseColors('--color-accent: #fff;', TOKENS);
  assert.equal(colors.set, '#fff');
  assert.equal(colors.rest, null);
  assert.equal(colors.prep, null);
  assert.equal(colors.overrun, null);
});

test('findConflicts is clean for four distinct colors', () => {
  const { missing, collisions } = findConflicts(
    readPhaseColors(extractThemeBlocks(GOOD_CSS).navy, TOKENS),
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(collisions, []);
});

test('findConflicts catches the accent/rest collision this guard exists for', () => {
  const { collisions } = findConflicts({
    set: '#22c55e',
    rest: '#22c55e',
    prep: '#d97706',
    overrun: '#dc2626',
  });
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].phases.sort(), ['rest', 'set']);
  assert.equal(collisions[0].color, '#22c55e');
});

test('findConflicts reports a missing token', () => {
  const { missing } = findConflicts({
    set: '#22c55e',
    rest: null,
    prep: '#d97706',
    overrun: '#dc2626',
  });
  assert.deepEqual(missing, ['rest']);
});

test('DIAL_PHASES covers exactly the four dial states', () => {
  assert.deepEqual([...DIAL_PHASES].sort(), ['overrun', 'prep', 'rest', 'set']);
});

// --- The phase -> token map is derived from the dial, not assumed ---

test('readDialTokens derives each phase token from the dial stylesheet', () => {
  const { tokens, problems } = readDialTokens(GOOD_DIAL);
  assert.deepEqual(problems, []);
  assert.deepEqual(tokens, {
    set: '--color-accent',
    rest: '--color-rest',
    prep: '--color-prep',
    overrun: '--color-error-text',
  });
});

test('readDialTokens follows the dial when a phase is repointed at another token', () => {
  // Known-bad: the exact #958 regression — .rest reverted to --color-success,
  // which equals --color-accent under `iron`. The guard must SEE the new token,
  // not keep comparing the one it used to use.
  const reverted = GOOD_DIAL.replace(
    '.rest { stroke: var(--color-rest); }',
    '.rest { stroke: var(--color-success); }',
  );
  const { tokens } = readDialTokens(reverted);
  assert.equal(tokens.rest, '--color-success');

  const ironWithSuccess = `
[data-theme="iron"] {
  --color-accent: #22c55e;
  --color-success: #22c55e;
  --color-prep: #d97706;
  --color-error-text: #dc2626;
}
`;
  const { collisions } = findConflicts(
    readPhaseColors(extractThemeBlocks(ironWithSuccess).iron, tokens),
  );
  assert.equal(collisions.length, 1, 'repointing .rest at --color-success must be caught');
  assert.deepEqual(collisions[0].phases.sort(), ['rest', 'set']);
});

test('readDialTokens reports a missing class rather than skipping the phase', () => {
  const { problems } = readDialTokens(GOOD_DIAL.replace('.prep { stroke: var(--color-prep); }', ''));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\.prep/);
});

test('readDialTokens reports a literal stroke rather than treating it as checkable', () => {
  const { problems } = readDialTokens(
    GOOD_DIAL.replace('.rest { stroke: var(--color-rest); }', '.rest { stroke: #27ae60; }'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /literal/);
});

test('the real dial stylesheet resolves to four checkable tokens', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dialCss = readFileSync(
    resolve(repoRoot, 'apps/web/components/timer/TimerDial.module.css'),
    'utf8',
  );
  const { tokens, problems } = readDialTokens(dialCss);
  assert.deepEqual(problems, [], 'every dial phase must stroke a custom property');
  assert.equal(Object.keys(tokens).length, DIAL_PHASES.length);
});

// --- Cascade precedence: a later declaration is the one that resolves ---

test('readPhaseColors takes the LAST declaration, matching the cascade', () => {
  // Known-bad: a redeclaration inside a media query reintroduces the collision.
  // Reading the first declaration would report the (stale) distinct value.
  const redeclared = `
[data-theme="iron"] {
  --color-accent: #22c55e;
  --color-rest: #0284c7;
  --color-prep: #d97706;
  --color-error-text: #dc2626;
}

@media (min-width: 40rem) {
  [data-theme="iron"] {
    --color-rest: #22c55e;
  }
}
`;
  const colors = readPhaseColors(extractThemeBlocks(redeclared).iron, TOKENS);
  assert.equal(colors.rest, '#22c55e', 'the later declaration must win');

  const { collisions } = findConflicts(colors);
  assert.equal(collisions.length, 1, 'a redeclared collision must still be caught');
  assert.deepEqual(collisions[0].phases.sort(), ['rest', 'set']);
});

test('readPhaseColors accepts a final declaration with no trailing semicolon', () => {
  const colors = readPhaseColors('--color-accent: #3498db; --color-rest: #27ae60', TOKENS);
  assert.equal(colors.rest, '#27ae60');
});

// --- Partial extraction is a vacuous pass too ---

test('declaredThemeNames sees theme names the block pattern must also match', () => {
  const css = `
[data-theme="navy"] { --color-accent: #3498db; }
[data-theme="high_contrast2"] { --color-accent: #000; }
`;
  assert.deepEqual(declaredThemeNames(css).sort(), ['high_contrast2', 'navy']);
  // Both must extract — a name with a digit or underscore was previously skipped
  // silently, which passes the non-empty check while checking nothing.
  assert.deepEqual(Object.keys(extractThemeBlocks(css)).sort(), ['high_contrast2', 'navy']);
});
