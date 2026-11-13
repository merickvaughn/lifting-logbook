#!/usr/bin/env node
/**
 * Validates that the import Assign step's macrocycle-status colors stay mutually distinct
 * within every theme defined in apps/web/app/globals.css (#1256).
 *
 * The Assign step marks each macrocycle with its status: completed, in progress, ran past its
 * length, unfinished, unknown, or not yet chosen. Each status is also written out, so color is
 * never the only signal, but two statuses sharing a color in one theme would make the list harder
 * to scan, and nothing else catches it: both tokens are valid, every test passes, and the page
 * renders.
 *
 * Like check-timer-phase-colors.mjs, whose theme-reading helpers this reuses, both halves of the
 * pairing are read from source:
 *
 *   1. The statuses come from `MACROCYCLE_STATUSES` in packages/types/src/domain.ts, plus `unset`,
 *      the step's own state for a status the lifter still has to choose.
 *   2. Which custom property paints each status comes from AssignStep.module.css, whose
 *      `.status-<name>` rules set `--status` from a `var(--color-status-…)` token.
 *   3. What each token resolves to comes from globals.css, read last-wins.
 *
 * Usage: node scripts/check-macrocycle-status-colors.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  declaredThemeNames,
  extractThemeBlocks,
  findConflicts,
  readPhaseColors,
} from './check-timer-phase-colors.mjs';

/** The Assign step's state for a stretch with no status yet. Not a stored status. */
export const NON_STORED_STATES = ['unset'];

/**
 * The statuses `packages/types` declares, read out of `MACROCYCLE_STATUSES`. Returns `null`
 * when the array can't be found, which {@link main} treats as a failure rather than a pass.
 */
export function readStatuses(domainTs) {
  const match = domainTs.match(/MACROCYCLE_STATUSES\s*=\s*\[([^\]]*)\]\s*as const/);
  if (!match) return null;
  const statuses = [...match[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  return statuses.length > 0 ? statuses : null;
}

/**
 * Maps each status to the custom property its `.status-<name>` rule sets `--status` from.
 * A status with no rule, or one set to a literal, is a problem rather than a skip.
 */
export function readStatusTokens(css, statuses) {
  const tokens = {};
  const problems = [];
  for (const status of statuses) {
    const rule = css.match(new RegExp(`\\.status-${status}\\s*\\{([^}]*)\\}`));
    if (!rule) {
      problems.push(`.status-${status} has no rule in AssignStep.module.css`);
      continue;
    }
    const value = rule[1].match(/--status\s*:\s*([^;}]+)/);
    const varName = value?.[1].trim().match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (!varName) {
      problems.push(`.status-${status} doesn't set --status from a var(--custom-property)`);
      continue;
    }
    tokens[status] = varName[1];
  }
  return { tokens, problems };
}

function fail(lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const css = readFileSync(resolve(repoRoot, 'apps/web/app/globals.css'), 'utf8');
  const stepCss = readFileSync(resolve(repoRoot, 'apps/web/app/(authed)/import/AssignStep.module.css'), 'utf8');
  const stored = readStatuses(readFileSync(resolve(repoRoot, 'packages/types/src/domain.ts'), 'utf8'));
  if (stored === null) {
    fail([
      'FAIL: could not read MACROCYCLE_STATUSES from packages/types/src/domain.ts.',
      '      Without it this guard would check no statuses and report a clean pass.',
    ]);
  }
  const statuses = [...stored, ...NON_STORED_STATES];

  const { tokens, problems } = readStatusTokens(stepCss, statuses);
  if (problems.length > 0) {
    fail([
      'FAIL: cannot resolve the status colors from AssignStep.module.css.\n',
      ...problems.map((p) => `  ${p}`),
      '\nEach status needs a `.status-<name> { --status: var(--color-status-<name>); }` rule.',
    ]);
  }

  const blocks = extractThemeBlocks(css);
  const themes = Object.keys(blocks);
  if (themes.length === 0) {
    fail(['FAIL: no [data-theme="…"] blocks found in apps/web/app/globals.css. That is a vacuous pass.']);
  }
  const skipped = declaredThemeNames(css).filter((name) => !themes.includes(name));
  if (skipped.length > 0) {
    fail([`FAIL: theme(s) declared in globals.css but not extracted: ${skipped.join(', ')}.`]);
  }

  const failures = [];
  for (const theme of themes) {
    const { missing, collisions } = findConflicts(readPhaseColors(blocks[theme], tokens));
    if (missing.length > 0) {
      failures.push(
        `  [data-theme="${theme}"] does not define: ${missing.map((s) => `${tokens[s]} (${s})`).join(', ')}`,
      );
    }
    for (const { color, phases } of collisions) {
      failures.push(`  [data-theme="${theme}"] paints ${phases.join(' and ')} the same color (${color}).`);
    }
  }
  if (failures.length > 0) {
    fail([
      'FAIL: macrocycle statuses are not distinguishable by color.\n',
      failures.join('\n'),
      `\nEach theme must give ${statuses.join('/')} ${statuses.length} different colors. See #1256.`,
    ]);
  }

  console.log(
    `OK: macrocycle status colors are distinct in all ${themes.length} theme(s) (${themes.join(', ')}); ` +
      `${statuses.length} statuses checked.`,
  );
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
