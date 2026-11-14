import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { NON_STORED_STATES, readStatusTokens, readStatuses } from './check-macrocycle-status-colors.mjs';
import { extractThemeBlocks, findConflicts, readPhaseColors } from './check-timer-phase-colors.mjs';

const STATUSES = ['completed', 'abandoned', 'overran', 'in-progress', 'unknown', 'unset'];

const STEP_CSS = STATUSES.map((s) => `.status-${s} { --status: var(--color-status-${s}); }`).join('\n');

const theme = (name, colors) =>
  `[data-theme="${name}"] {\n${STATUSES.map((s, i) => `  --color-status-${s}: ${colors[i]};`).join('\n')}\n}`;

const GOOD_CSS = `:root,\n${theme('navy', ['#1e8449', '#5f6b6d', '#b9770e', '#2471a3', '#6c3483', '#c0392b'])}\n${theme(
  'iron',
  ['#15803d', '#52525b', '#b45309', '#0369a1', '#6d28d9', '#dc2626'],
)}`;

function check(css, stepCss = STEP_CSS) {
  const { tokens, problems } = readStatusTokens(stepCss, STATUSES);
  const blocks = extractThemeBlocks(css);
  return {
    problems,
    collisions: Object.fromEntries(
      Object.entries(blocks).map(([name, body]) => [name, findConflicts(readPhaseColors(body, tokens))]),
    ),
  };
}

test('readStatuses reads MACROCYCLE_STATUSES', () => {
  const ts = "export const MACROCYCLE_STATUSES = ['completed', 'abandoned', 'overran', 'in-progress', 'unknown'] as const;";
  assert.deepEqual(readStatuses(ts), ['completed', 'abandoned', 'overran', 'in-progress', 'unknown']);
  assert.equal(readStatuses('export const OTHER = [];'), null);
});

test('readStatusTokens maps each status to its token', () => {
  const { tokens, problems } = readStatusTokens(STEP_CSS, STATUSES);
  assert.deepEqual(problems, []);
  assert.equal(tokens['in-progress'], '--color-status-in-progress');
});

test('readStatusTokens reports a missing rule and a literal color', () => {
  const css = STEP_CSS.replace(/\.status-unset[^\n]*/, '').replace(
    'var(--color-status-completed)',
    '#1e8449',
  );
  const { problems } = readStatusTokens(css, STATUSES);
  assert.equal(problems.length, 2);
});

test('distinct colors pass in every theme', () => {
  const { problems, collisions } = check(GOOD_CSS);
  assert.deepEqual(problems, []);
  for (const result of Object.values(collisions)) {
    assert.deepEqual(result, { missing: [], collisions: [] });
  }
});

test('known bad: two statuses sharing a color in one theme', () => {
  const bad = GOOD_CSS.replace('--color-status-overran: #b45309', '--color-status-overran: #15803d');
  const { collisions } = check(bad);
  assert.deepEqual(collisions.iron.collisions, [{ color: '#15803d', phases: ['completed', 'overran'] }]);
  assert.deepEqual(collisions.navy.collisions, []);
});

test('known bad: a status repointed at another status token', () => {
  const stepCss = STEP_CSS.replace('var(--color-status-unknown)', 'var(--color-status-abandoned)');
  const { collisions } = check(GOOD_CSS, stepCss);
  assert.equal(collisions.navy.collisions.length, 1);
});

test('known bad: a theme missing a token', () => {
  const bad = GOOD_CSS.replace('  --color-status-unset: #dc2626;', '');
  const { collisions } = check(bad);
  assert.deepEqual(collisions.iron.missing, ['unset']);
});

test('the real stylesheets pass, and cover every stored status plus unset', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const stored = readStatuses(readFileSync(resolve(root, 'packages/types/src/domain.ts'), 'utf8'));
  assert.ok(stored && stored.length > 0);
  const statuses = [...stored, ...NON_STORED_STATES];
  const stepCss = readFileSync(resolve(root, 'apps/web/app/(authed)/import/AssignStep.module.css'), 'utf8');
  const { tokens, problems } = readStatusTokens(stepCss, statuses);
  assert.deepEqual(problems, []);
  const blocks = extractThemeBlocks(readFileSync(resolve(root, 'apps/web/app/globals.css'), 'utf8'));
  assert.ok(Object.keys(blocks).length >= 2);
  for (const [name, body] of Object.entries(blocks)) {
    assert.deepEqual(findConflicts(readPhaseColors(body, tokens)), { missing: [], collisions: [] }, name);
  }
});
