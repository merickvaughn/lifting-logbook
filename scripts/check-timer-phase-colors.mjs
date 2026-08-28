#!/usr/bin/env node
/**
 * Validates that the rest timer's four dial-phase colors stay mutually distinct
 * within every theme defined in apps/web/app/globals.css.
 *
 * The countdown ring paints exactly one of four states — set (`--color-accent`),
 * rest (`--color-rest`), prep (`--color-prep`) and overrun (`--color-error-text`)
 * — so if any two resolve to the same value inside a theme, the ring silently
 * stops carrying information for that pair. Nothing else catches it: both colors
 * are valid tokens, every test passes, and the page renders without complaint.
 *
 * This is not hypothetical. The timer originally used `--color-success` for rest,
 * which is correct under `navy` (accent #3498db vs. success #27ae60) but collapses
 * under `iron`, where the accent IS green — both resolved to #22c55e, making a
 * working set and a rest indistinguishable at a glance. `--color-rest` exists to
 * break that tie, and this guard is what stops it reappearing when a theme is
 * added or an accent retuned. See #958 / ADR-035.
 *
 * Usage: node scripts/check-timer-phase-colors.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/** Dial phase -> the custom property TimerDial.module.css strokes it with. */
export const PHASE_TOKENS = {
  set: '--color-accent',
  rest: '--color-rest',
  prep: '--color-prep',
  overrun: '--color-error-text',
};

// --- Pure parsing helpers (exported for unit testing) ---

/**
 * Extracts each theme's declaration block, keyed by theme name.
 *
 * Matches `[data-theme="<name>"] { … }` selectors, including the default block
 * that pairs `:root` with `[data-theme="navy"]`.
 */
export function extractThemeBlocks(css) {
  const blocks = {};
  const selector = /(?:^|\})([^{}]*\[data-theme="([a-z-]+)"\][^{}]*)\{([^}]*)\}/gm;
  let match;
  while ((match = selector.exec(css)) !== null) {
    const [, , theme, body] = match;
    // A theme can legitimately appear more than once (e.g. inside a media query);
    // later declarations win in CSS, so later blocks overwrite earlier ones here.
    blocks[theme] = (blocks[theme] ?? '') + body;
  }
  return blocks;
}

/** Reads the four phase colors out of one theme's declaration body. */
export function readPhaseColors(body) {
  const colors = {};
  for (const [phase, token] of Object.entries(PHASE_TOKENS)) {
    const found = body.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
    colors[phase] = found ? found[1].trim() : null;
  }
  return colors;
}

/** Phases whose color is absent, and the groups of phases that share one. */
export function findConflicts(colors) {
  const missing = Object.entries(colors)
    .filter(([, value]) => value === null)
    .map(([phase]) => phase);

  const byColor = new Map();
  for (const [phase, value] of Object.entries(colors)) {
    if (value === null) continue;
    byColor.set(value, [...(byColor.get(value) ?? []), phase]);
  }
  const collisions = [...byColor.entries()]
    .filter(([, phases]) => phases.length > 1)
    .map(([color, phases]) => ({ color, phases }));

  return { missing, collisions };
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cssPath = resolve(repoRoot, 'apps/web/app/globals.css');
  const css = readFileSync(cssPath, 'utf8');

  const blocks = extractThemeBlocks(css);
  const themes = Object.keys(blocks);

  // An extraction that silently found nothing would compare an empty set and
  // "pass" — assert the corpus is non-empty separately from the comparison.
  if (themes.length === 0) {
    console.error(
      'FAIL: no [data-theme="…"] blocks found in apps/web/app/globals.css.\n' +
        '      That is a vacuous pass, not a clean one — the selector shape likely changed.',
    );
    process.exit(1);
  }

  const failures = [];
  for (const theme of themes) {
    const colors = readPhaseColors(blocks[theme]);
    const { missing, collisions } = findConflicts(colors);

    if (missing.length > 0) {
      failures.push(
        `  [data-theme="${theme}"] does not define: ` +
          missing.map((p) => `${PHASE_TOKENS[p]} (${p})`).join(', '),
      );
    }
    for (const { color, phases } of collisions) {
      failures.push(
        `  [data-theme="${theme}"] paints ${phases.join(' and ')} the same color (${color}) — ` +
          'the dial cannot distinguish those phases.',
      );
    }
  }

  if (failures.length > 0) {
    console.error('FAIL: rest-timer dial phases are not distinguishable.\n');
    console.error(failures.join('\n'));
    console.error(
      '\nEach theme must give set/rest/prep/overrun four different colors.\n' +
        'See #958 and docs/adr/ADR-035-client-side-rest-timer-state.md.',
    );
    process.exit(1);
  }

  console.log(
    `OK: rest-timer dial phases are distinct in all ${themes.length} theme(s) ` +
      `(${themes.join(', ')}).`,
  );
  process.exit(0);
}

// Only run when executed directly, so the pure helpers above can be imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
