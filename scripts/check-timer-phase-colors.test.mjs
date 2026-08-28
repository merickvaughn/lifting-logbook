import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_TOKENS,
  extractThemeBlocks,
  findConflicts,
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
  const colors = readPhaseColors(extractThemeBlocks(GOOD_CSS).iron);
  assert.deepEqual(colors, {
    set: '#22c55e',
    rest: '#0284c7',
    prep: '#d97706',
    overrun: '#dc2626',
  });
});

test('readPhaseColors reports an absent token as null rather than guessing', () => {
  const colors = readPhaseColors('--color-accent: #fff;');
  assert.equal(colors.set, '#fff');
  assert.equal(colors.rest, null);
  assert.equal(colors.prep, null);
  assert.equal(colors.overrun, null);
});

test('findConflicts is clean for four distinct colors', () => {
  const { missing, collisions } = findConflicts(
    readPhaseColors(extractThemeBlocks(GOOD_CSS).navy),
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(collisions, []);
});

test('findConflicts catches the accent/rest collision this guard exists for', () => {
  // The original #958 bug: rest used --color-success, which under `iron` is the
  // same green as the accent, so a working set and a rest painted identically.
  const { collisions } = findConflicts({
    set: '#22c55e',
    rest: '#22c55e',
    prep: '#d97706',
    overrun: '#dc2626',
  });

  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].color, '#22c55e');
  assert.deepEqual(collisions[0].phases.sort(), ['rest', 'set']);
});

test('findConflicts reports a missing token', () => {
  const { missing } = findConflicts({
    set: '#3498db',
    rest: null,
    prep: '#e0a800',
    overrun: '#c0392b',
  });
  assert.deepEqual(missing, ['rest']);
});

test('PHASE_TOKENS covers exactly the four dial states', () => {
  assert.deepEqual(Object.keys(PHASE_TOKENS).sort(), ['overrun', 'prep', 'rest', 'set']);
});
