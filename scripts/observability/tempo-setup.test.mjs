// Unit tests for scripts/observability/tempo-setup.sh (#949).
//
// The script mutates the user's ~/.bashrc — a file it does not own, holding arbitrary unrelated
// content — so the behavior worth locking down is not "did it save the values" but "did it leave
// everything else intact". Every test below runs the real script with HOME pointed at a throwaway
// directory and asserts against the resulting file.
//
// SAFETY: each run asserts the sandbox HOME actually took effect before making any other
// assertion. If HOME were ever not honored, the script would append to the developer's real
// ~/.bashrc, so this check fails loudly rather than letting a silent escape look like a pass.
// The credentials fed in are fixtures; no real token is involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT = path.join(HERE, 'tempo-setup.sh');

const BEGIN = '# >>> tempo-query-env >>>';
const END = '# <<< tempo-query-env <<<';

// Pre-existing content the script must never disturb.
const EXISTING_BASHRC = [
  '# the developer had this here first',
  'export PATH="$HOME/bin:$PATH"',
  'alias ll="ls -la"',
  '',
  '# >>> mimir-query-env >>>',
  'export MIMIR_ADDRESS=https://mimir.invalid',
  '# <<< mimir-query-env <<<',
].join('\n');

function requireBash() {
  if (spawnSync('bash', ['--version'], { encoding: 'utf8' }).error) {
    throw new Error(
      "'bash' is required to test tempo-setup.sh but was not found on PATH. " +
        'Run these tests from Git Bash (Windows) or any POSIX shell environment.',
    );
  }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TEMPO_')) delete env[key];
  }
  return { ...env, ...extra };
}

function makeHome(bashrcContent = EXISTING_BASHRC) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-setup-test-'));
  if (bashrcContent !== null) {
    fs.writeFileSync(path.join(home, '.bashrc'), `${bashrcContent}\n`);
  }
  return home;
}

/** Run tempo-setup.sh with the four prompt answers piped in, HOME sandboxed. */
function runSetup(home, { address, user, key, tenant = '' }) {
  const answers = `${address}\n${user}\n${key}\n${tenant}\n`;
  const res = spawnSync('bash', [SETUP_SCRIPT], {
    input: answers,
    encoding: 'utf8',
    env: cleanEnv({ HOME: home.replace(/\\/g, '/') }),
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const bashrcOf = (home) => fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
const anchorPath = (home) => path.join(home, '.bashrc.tempo-setup.orig');
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

/** Source the produced .bashrc in a fresh shell and echo one variable back. */
function readBackVar(home, varName) {
  const res = spawnSync('bash', ['-c', `. "$HOME/.bashrc"; printf '%s' "\${${varName}:-}"`], {
    encoding: 'utf8',
    env: cleanEnv({ HOME: home.replace(/\\/g, '/') }),
  });
  return res.stdout ?? '';
}

const cleanup = (home) => fs.rmSync(home, { recursive: true, force: true });

test('a first run appends one managed block and preserves existing content', () => {
  requireBash();
  const home = makeHome();
  try {
    const out = runSetup(home, {
      address: 'https://tempo-fixture.invalid',
      user: '111111',
      key: 'glc_fixture_not_a_real_token',
    });
    assert.equal(out.status, 0, `expected success, got stderr: ${out.stderr}`);

    const bashrc = bashrcOf(home);
    // Sandbox check first: if HOME were not honored, this file would lack the marker entirely.
    assert.equal(countOccurrences(bashrc, BEGIN), 1, 'exactly one managed block expected');
    assert.equal(countOccurrences(bashrc, END), 1);

    // Everything that was there before must survive untouched, including the sibling
    // mimir-query-env block, whose delimiters are deliberately similar.
    for (const line of EXISTING_BASHRC.split('\n').filter(Boolean)) {
      assert.ok(bashrc.includes(line), `pre-existing line lost: ${line}`);
    }
    assert.equal(countOccurrences(bashrc, '# >>> mimir-query-env >>>'), 1);

    assert.match(bashrc, /export TEMPO_STAGING_ADDRESS=/);
    assert.match(bashrc, /export TEMPO_STAGING_API_USER=/);
    assert.match(bashrc, /export TEMPO_STAGING_API_KEY=/);
    // Tenant was left blank, so it must not be emitted at all.
    assert.doesNotMatch(bashrc, /TEMPO_STAGING_TENANT_ID/);
  } finally {
    cleanup(home);
  }
});

test('a second run replaces the managed block instead of duplicating it', () => {
  requireBash();
  const home = makeHome();
  try {
    runSetup(home, { address: 'https://first.invalid', user: '111111', key: 'glc_first' });
    const out = runSetup(home, { address: 'https://second.invalid', user: '222222', key: 'glc_second' });
    assert.equal(out.status, 0, `expected success, got stderr: ${out.stderr}`);

    const bashrc = bashrcOf(home);
    assert.equal(countOccurrences(bashrc, BEGIN), 1, 'idempotent: still exactly one block');
    assert.ok(!bashrc.includes('https://first.invalid'), 'stale value should be gone');
    assert.equal(readBackVar(home, 'TEMPO_STAGING_ADDRESS'), 'https://second.invalid');
    assert.equal(readBackVar(home, 'TEMPO_STAGING_API_USER'), '222222');
    // The rewrite path replaces the whole file — unrelated content must still survive it.
    assert.ok(bashrc.includes('alias ll="ls -la"'));
    assert.equal(countOccurrences(bashrc, '# >>> mimir-query-env >>>'), 1);
  } finally {
    cleanup(home);
  }
});

test('the backup anchor captures the pre-tempo-setup state and survives re-runs', () => {
  requireBash();
  const home = makeHome();
  try {
    runSetup(home, { address: 'https://first.invalid', user: '111111', key: 'glc_first' });
    assert.ok(fs.existsSync(anchorPath(home)), 'anchor should be written on first run');
    const afterFirst = fs.readFileSync(anchorPath(home), 'utf8');
    assert.equal(afterFirst, `${EXISTING_BASHRC}\n`, 'anchor must hold the ORIGINAL file');

    runSetup(home, { address: 'https://second.invalid', user: '222222', key: 'glc_second' });
    // Written-if-absent: a re-run must not overwrite the anchor with the already-modified file,
    // or repeated runs would erode the only copy of the user's original config.
    assert.equal(
      fs.readFileSync(anchorPath(home), 'utf8'),
      afterFirst,
      'anchor must not be overwritten on re-run',
    );
    assert.doesNotMatch(fs.readFileSync(anchorPath(home), 'utf8'), /TEMPO_STAGING_/);
  } finally {
    cleanup(home);
  }
});

test('values containing shell metacharacters round-trip through %q quoting', () => {
  requireBash();
  const home = makeHome();
  try {
    // A token with a space, a single quote, a backtick and a dollar sign: re-sourcing the file
    // must yield the value verbatim, not a word-split, command-substituted or expanded version.
    const nastyKey = "glc_a b'c`d$e";
    const out = runSetup(home, {
      address: 'https://tempo-fixture.invalid',
      user: '111111',
      key: nastyKey,
      tenant: 'tenant one',
    });
    assert.equal(out.status, 0, `expected success, got stderr: ${out.stderr}`);
    assert.equal(readBackVar(home, 'TEMPO_STAGING_API_KEY'), nastyKey);
    assert.equal(readBackVar(home, 'TEMPO_STAGING_TENANT_ID'), 'tenant one');
  } finally {
    cleanup(home);
  }
});

test('a missing required field saves nothing and leaves .bashrc untouched', () => {
  requireBash();
  const home = makeHome();
  try {
    const before = bashrcOf(home);
    // Blank address — the script must refuse before writing anything.
    const out = runSetup(home, { address: '', user: '111111', key: 'glc_fixture' });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /are all required. Nothing saved/);
    assert.equal(bashrcOf(home), before, '.bashrc must be byte-identical after a refusal');
    assert.ok(!bashrcOf(home).includes(BEGIN));
    // The refusal happens before the backup stage, so no anchor should exist either.
    assert.ok(!fs.existsSync(anchorPath(home)), 'no anchor should be written on a refusal');
  } finally {
    cleanup(home);
  }
});

test('a missing ~/.bashrc is created rather than erroring', () => {
  requireBash();
  const home = makeHome(null); // no .bashrc at all
  try {
    const out = runSetup(home, {
      address: 'https://tempo-fixture.invalid',
      user: '111111',
      key: 'glc_fixture',
    });
    assert.equal(out.status, 0, `expected success, got stderr: ${out.stderr}`);
    assert.equal(countOccurrences(bashrcOf(home), BEGIN), 1);
    assert.equal(readBackVar(home, 'TEMPO_STAGING_API_USER'), '111111');
  } finally {
    cleanup(home);
  }
});

test('a failure while sourced returns non-zero without killing the calling shell', () => {
  requireBash();
  const home = makeHome();
  try {
    // The highest-consequence path in the script: an `exit` reached while sourced would kill
    // the user's interactive terminal. The caller must survive, observe a non-zero status, and
    // see nothing saved. Blank address triggers the refusal.
    const probe = [
      `. "${SETUP_SCRIPT.replace(/\\/g, '/')}" > /dev/null 2>&1`,
      'rc=$?',
      'printf "PROBE_RC=%s\\n" "$rc"',
      'printf "PROBE_ALIVE=yes\\n"', // only prints if the source did not exit the shell
    ].join('\n');
    const res = spawnSync('bash', ['-c', probe], {
      input: '\n111111\nglc_fixture\n\n',
      encoding: 'utf8',
      env: cleanEnv({ HOME: home.replace(/\\/g, '/') }),
    });
    assert.match(res.stdout, /PROBE_ALIVE=yes/, 'the calling shell must survive the failure');
    assert.match(res.stdout, /PROBE_RC=1/, 'the failure must surface as a non-zero status');
    assert.ok(!bashrcOf(home).includes(BEGIN), 'nothing should have been saved');
  } finally {
    cleanup(home);
  }
});

test('sourcing the script exports into the calling shell', () => {
  requireBash();
  const home = makeHome();
  try {
    // The documented `source scripts/observability/tempo-setup.sh` path — the exports must
    // survive into the caller, which is the whole reason the script supports being sourced.
    const probe = [
      `. "${SETUP_SCRIPT.replace(/\\/g, '/')}" > /dev/null 2>&1`,
      'printf "PROBE=%s" "${TEMPO_STAGING_API_USER:-unset}"',
    ].join('\n');
    const res = spawnSync('bash', ['-c', probe], {
      input: 'https://tempo-fixture.invalid\n111111\nglc_fixture\n\n',
      encoding: 'utf8',
      env: cleanEnv({ HOME: home.replace(/\\/g, '/') }),
    });
    assert.match(res.stdout, /PROBE=111111/);
  } finally {
    cleanup(home);
  }
});
