// Unit tests for scripts/observability/tempo-query-env.sh (#949).
//
// The script is sourced bash, so it is exercised by actually sourcing it in a bash
// subshell against fixture credentials in a throwaway directory and reading back the
// variables it exported. Nothing here touches a real credential: every value below is a
// fixture, and the child environment is scrubbed of all TEMPO_* variables first — a
// developer who has run tempo-setup.sh has the real ones exported in their shell, and
// without the scrub they would leak in and mask the behavior under test.
//
// Coverage focus is the resolution logic #949 changed: the TEMPO_TARGET=prod shared-stack
// fallback (which previously failed outright, since the prod block ships unfilled) and the
// canonical-checkout credentials lookup (which is what makes a credentials file survive
// the deletion of the worktree it was created in).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_SCRIPT = path.join(HERE, 'tempo-query-env.sh');

const STAGING_FIXTURE = [
  'export TEMPO_STAGING_ADDRESS="https://tempo-fixture-staging.invalid"',
  'export TEMPO_STAGING_API_USER="111111"',
  'export TEMPO_STAGING_API_KEY="glc_fixture_staging_not_a_real_token"',
].join('\n');

const PROD_FIXTURE = [
  'export TEMPO_PROD_ADDRESS="https://tempo-fixture-prod.invalid"',
  'export TEMPO_PROD_API_USER="222222"',
  'export TEMPO_PROD_API_KEY="glc_fixture_prod_not_a_real_token"',
].join('\n');

/** Environment for the bash child: inherit everything except real TEMPO_* values. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TEMPO_')) delete env[key];
  }
  return { ...env, ...extra };
}

function requireBinary(name) {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(
      `'${name}' is required to test tempo-query-env.sh but was not found on PATH. ` +
        'Run these tests from Git Bash (Windows) or any POSIX shell environment.',
    );
  }
}

/**
 * Lay out a throwaway directory holding a copy of the env script (and optionally a
 * credentials file next to it), then source the script and report what it exported.
 */
function makeSandbox(credentials) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-env-test-'));
  const obs = path.join(root, 'scripts', 'observability');
  fs.mkdirSync(obs, { recursive: true });
  fs.copyFileSync(ENV_SCRIPT, path.join(obs, 'tempo-query-env.sh'));
  if (credentials !== undefined) {
    fs.writeFileSync(path.join(obs, '.tempo-credentials'), `${credentials}\n`);
  }
  return root;
}

/** Source the script from `cwd` and return { rc, address, user, key, stdout, stderr }. */
function sourceEnv(cwd, extraEnv = {}) {
  const probe = [
    'source ./scripts/observability/tempo-query-env.sh',
    'rc=$?',
    'echo "PROBE_RC=$rc"',
    'echo "PROBE_ADDRESS=${TEMPO_ADDRESS:-}"',
    'echo "PROBE_USER=${TEMPO_API_USER:-}"',
    'echo "PROBE_KEY=${TEMPO_API_KEY:-}"',
  ].join('\n');

  const res = spawnSync('bash', ['-c', probe], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
  });

  const field = (name) => {
    const match = res.stdout.match(new RegExp(`^PROBE_${name}=(.*)$`, 'm'));
    return match ? match[1].trim() : undefined;
  };

  return {
    rc: Number(field('RC')),
    address: field('ADDRESS'),
    user: field('USER'),
    key: field('KEY'),
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('staging is the default target and exports the staging credential set', () => {
  requireBinary('bash');
  const root = makeSandbox(STAGING_FIXTURE);
  try {
    const out = sourceEnv(root);
    assert.equal(out.rc, 0, `expected success, got stderr: ${out.stderr}`);
    assert.equal(out.address, 'https://tempo-fixture-staging.invalid');
    assert.equal(out.user, '111111');
    assert.match(out.stdout, /Tempo query env ready \[staging\]/);
  } finally {
    cleanup(root);
  }
});

test('TEMPO_TARGET=prod falls back to the staging set when no TEMPO_PROD_* is configured', () => {
  requireBinary('bash');
  // The regression this guards: the shipped credentials template leaves the prod block
  // commented out, so before #949 the documented `TEMPO_TARGET=prod` path failed with a
  // missing-variable error even though one Grafana Cloud stack serves both environments.
  const root = makeSandbox(STAGING_FIXTURE);
  try {
    const out = sourceEnv(root, { TEMPO_TARGET: 'prod' });
    assert.equal(out.rc, 0, `expected success, got stderr: ${out.stderr}`);
    assert.equal(out.address, 'https://tempo-fixture-staging.invalid');
    assert.equal(out.user, '111111');
    assert.match(out.stdout, /no TEMPO_PROD_\* configured/);
    assert.match(out.stdout, /SAME Grafana Cloud stack/);
    assert.match(out.stdout, /deployment\.environment\.name/);
    assert.match(out.stdout, /\[prod via shared stack\]/);
  } finally {
    cleanup(root);
  }
});

test('a filled TEMPO_PROD_* block takes precedence over the shared-stack fallback', () => {
  requireBinary('bash');
  const root = makeSandbox(`${STAGING_FIXTURE}\n${PROD_FIXTURE}`);
  try {
    const out = sourceEnv(root, { TEMPO_TARGET: 'prod' });
    assert.equal(out.rc, 0, `expected success, got stderr: ${out.stderr}`);
    assert.equal(out.address, 'https://tempo-fixture-prod.invalid');
    assert.equal(out.user, '222222');
    assert.doesNotMatch(out.stdout, /no TEMPO_PROD_\* configured/);
    assert.match(out.stdout, /Tempo query env ready \[prod\]/);
  } finally {
    cleanup(root);
  }
});

test('a partially filled TEMPO_PROD_* block errors instead of silently falling back', () => {
  requireBinary('bash');
  // A half-configured prod block means a separate prod stack is genuinely being set up.
  // Falling back there would silently query the wrong stack, so the missing-variable
  // error naming what is still needed is the correct outcome.
  const partial = `${STAGING_FIXTURE}\nexport TEMPO_PROD_ADDRESS="https://tempo-fixture-prod.invalid"`;
  const root = makeSandbox(partial);
  try {
    const out = sourceEnv(root, { TEMPO_TARGET: 'prod' });
    assert.equal(out.rc, 1);
    assert.match(out.stderr, /missing required variable\(s\) for target 'prod'/);
    assert.match(out.stderr, /TEMPO_API_USER/);
    assert.match(out.stderr, /TEMPO_API_KEY/);
    assert.doesNotMatch(out.stdout, /no TEMPO_PROD_\* configured/);
  } finally {
    cleanup(root);
  }
});

test('an unknown TEMPO_TARGET is rejected', () => {
  requireBinary('bash');
  const root = makeSandbox(STAGING_FIXTURE);
  try {
    const out = sourceEnv(root, { TEMPO_TARGET: 'bogus' });
    assert.equal(out.rc, 1);
    assert.match(out.stderr, /TEMPO_TARGET must be 'staging' or 'prod'/);
  } finally {
    cleanup(root);
  }
});

test('missing credentials produce an actionable error naming tempo-setup.sh', () => {
  requireBinary('bash');
  const root = makeSandbox(undefined); // no credentials file at all
  try {
    const out = sourceEnv(root);
    assert.equal(out.rc, 1);
    assert.match(out.stderr, /missing required variable\(s\)/);
    assert.match(out.stderr, /tempo-setup\.sh/);
    assert.match(out.stderr, /\.tempo-credentials\.example/);
    // The write-only OTLP push tokens are the obvious wrong thing to reach for next.
    assert.match(out.stderr, /write-only/);
  } finally {
    cleanup(root);
  }
});

test('TEMPO_TARGET=prod with no credentials at all errors without claiming a fallback', () => {
  requireBinary('bash');
  // The fallback must not announce itself when there is no staging set to fall back to —
  // that would report a shared-stack credential the operator does not actually have.
  const root = makeSandbox(undefined);
  try {
    const out = sourceEnv(root, { TEMPO_TARGET: 'prod' });
    assert.equal(out.rc, 1);
    assert.match(out.stderr, /missing required variable\(s\) for target 'prod'/);
    assert.doesNotMatch(out.stdout, /no TEMPO_PROD_\* configured/);
    assert.doesNotMatch(out.stdout, /prod via shared stack/);
  } finally {
    cleanup(root);
  }
});

test('a linked worktree falls back to the canonical checkout credentials file', () => {
  requireBinary('bash');
  requireBinary('git');
  // The #949 fix. A worktree carries its own scripts/observability/, so a credentials
  // file in the canonical checkout is invisible from inside one — which is how the only
  // read credential on a machine ended up stranded in a prunable worktree.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-env-wt-'));
  const canonical = path.join(root, 'canonical');
  const worktree = path.join(root, 'linked');
  const git = (args, cwd) => {
    const res = spawnSync(
      'git',
      ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  };

  try {
    fs.mkdirSync(path.join(canonical, 'scripts', 'observability'), { recursive: true });
    fs.copyFileSync(ENV_SCRIPT, path.join(canonical, 'scripts', 'observability', 'tempo-query-env.sh'));
    git(['init', '--initial-branch=main', '.'], canonical);
    git(['add', '-A'], canonical);
    git(['commit', '-m', 'fixture'], canonical);

    // Credentials exist ONLY in the canonical checkout, never in the worktree.
    fs.writeFileSync(
      path.join(canonical, 'scripts', 'observability', '.tempo-credentials'),
      `${STAGING_FIXTURE}\n`,
    );
    git(['worktree', 'add', worktree, '-b', 'linked-branch'], canonical);
    assert.ok(
      !fs.existsSync(path.join(worktree, 'scripts', 'observability', '.tempo-credentials')),
      'the worktree must not have its own credentials file for this test to mean anything',
    );

    const out = sourceEnv(worktree);
    assert.equal(out.rc, 0, `expected success, got stderr: ${out.stderr}`);
    assert.equal(out.address, 'https://tempo-fixture-staging.invalid');
    assert.match(out.stdout, /credentials loaded from the canonical checkout/);
  } finally {
    // Detach the worktree before removing the tree, so git leaves nothing locked behind.
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: canonical });
    cleanup(root);
  }
});

test('executing the script instead of sourcing it is refused', () => {
  requireBinary('bash');
  const root = makeSandbox(STAGING_FIXTURE);
  try {
    const res = spawnSync('bash', ['./scripts/observability/tempo-query-env.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /must be sourced, not executed/);
  } finally {
    cleanup(root);
  }
});
