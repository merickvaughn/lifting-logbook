import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { HOOK_CONFIG_FILE, epicsBySlug, resolveEpic, slugify } from './project-board-epic.mjs';

const SCRIPT = fileURLToPath(new URL('./project-board-epic.mjs', import.meta.url));
const ROOT = resolve(dirname(SCRIPT), '..');
// The real cache, so a renamed Epic or a re-cut option ID is what these tests see (#1385).
const HOOK_CONFIG = JSON.parse(readFileSync(resolve(ROOT, HOOK_CONFIG_FILE), 'utf8'));
const EPIC_OPTIONS = HOOK_CONFIG.epic_options;

test('slugify turns Epic names into label slugs', () => {
  assert.equal(slugify('API Implementation'), 'api-implementation');
  assert.equal(slugify('Package & App Scaffolding'), 'package-and-app-scaffolding');
  assert.equal(slugify('CI/CD Foundation'), 'ci-cd-foundation');
  assert.equal(slugify('Architecture & Documentation'), 'architecture-and-documentation');
});

test('every Epic in hook-config.json gets its own label', () => {
  const bySlug = epicsBySlug(EPIC_OPTIONS);
  assert.equal(bySlug.size, Object.keys(EPIC_OPTIONS).length);
  for (const { name, optionId } of bySlug.values()) {
    assert.equal(EPIC_OPTIONS[name], optionId);
  }
});

test('two Epics with the same slug are rejected', () => {
  assert.throws(() => epicsBySlug({ 'CI/CD': 'a', 'CI CD': 'b' }), /both map to the label epic:ci-cd/);
});

test('an empty epic_options is rejected', () => {
  assert.throws(() => epicsBySlug({}), /no epic_options/);
  assert.throws(() => epicsBySlug(undefined), /no epic_options/);
});

test('an epic: label resolves to the option ID from hook-config.json', () => {
  for (const [name, optionId] of Object.entries(EPIC_OPTIONS)) {
    const result = resolveEpic(['bug', `epic:${slugify(name)}`], EPIC_OPTIONS);
    assert.deepEqual(result, { status: 'set', slug: slugify(name), name, optionId });
  }
});

test('the label match ignores case', () => {
  const result = resolveEpic(['Epic:Operations'], EPIC_OPTIONS);
  assert.equal(result.status, 'set');
  assert.equal(result.optionId, EPIC_OPTIONS.Operations);
});

test('no epic: label resolves to none', () => {
  assert.deepEqual(resolveEpic([], EPIC_OPTIONS), { status: 'none' });
  assert.deepEqual(resolveEpic(['bug', 'epicness'], EPIC_OPTIONS), { status: 'none' });
});

test('an unknown slug lists the valid slugs', () => {
  const result = resolveEpic(['epic:nope'], EPIC_OPTIONS);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.slugs, ['nope']);
  assert.deepEqual(result.validSlugs, Object.keys(EPIC_OPTIONS).map(slugify));
});

test('two epic: labels are rejected', () => {
  const result = resolveEpic(['epic:operations', 'epic:observability'], EPIC_OPTIONS);
  assert.deepEqual(result, { status: 'multiple', slugs: ['operations', 'observability'] });
});

/** Runs the CLI with the given labels and returns its exit code, stdout and $GITHUB_OUTPUT. */
function runCli(labels) {
  const outputFile = join(mkdtempSync(join(tmpdir(), 'project-board-epic-')), 'output');
  writeFileSync(outputFile, '');
  const run = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ISSUE_LABELS: JSON.stringify(labels), GITHUB_OUTPUT: outputFile },
    encoding: 'utf8',
  });
  return { status: run.status, stdout: run.stdout, output: readFileSync(outputFile, 'utf8') };
}

// Written on every run, so the workflow can add the issue to the board even when the label is bad.
const BOARD_OUTPUT =
  `project_url=https://github.com/users/${HOOK_CONFIG.project_owner}/projects/${HOOK_CONFIG.project_number}\n` +
  `project_id=${HOOK_CONFIG.project_node_id}\nfield_id=${HOOK_CONFIG.epic_field_id}\n`;

test('CLI: a known label writes the board coordinates and the option ID', () => {
  const { status, output } = runCli(['epic:api-implementation']);
  assert.equal(status, 0);
  assert.equal(output, `${BOARD_OUTPUT}option_id=${EPIC_OPTIONS['API Implementation']}\n`);
});

test('CLI: no epic: label succeeds, writes no option ID and annotates the run', () => {
  const { status, stdout, output } = runCli(['bug']);
  assert.equal(status, 0);
  assert.equal(output, BOARD_OUTPUT);
  assert.match(stdout, /^::notice title=Epic not set::/m);
});

test('CLI: an unknown slug fails and names every valid label', () => {
  const { status, stdout, output } = runCli(['epic:nope']);
  assert.equal(status, 1);
  assert.equal(output, BOARD_OUTPUT);
  assert.match(stdout, /^::error title=Unknown Epic label::No Epic matches epic:nope\./m);
  for (const name of Object.keys(EPIC_OPTIONS)) {
    assert.ok(stdout.includes(`epic:${slugify(name)}`), `missing epic:${slugify(name)}`);
  }
});

test('CLI: a newline in a label cannot start a second workflow command', () => {
  const { status, stdout } = runCli(['epic:x\n::set-env name=A::b']);
  assert.equal(status, 1);
  assert.doesNotMatch(stdout, /^::set-env/m);
});
