#!/usr/bin/env node
/**
 * Validates that the rest timer's four dial-phase colors stay mutually distinct
 * within every theme defined in apps/web/app/globals.css.
 *
 * The countdown ring paints exactly one of four states — set, rest, prep and
 * overrun — so if any two resolve to the same value inside a theme, the ring
 * silently stops carrying information for that pair. Nothing else catches it:
 * both colors are valid tokens, every test passes, and the page renders without
 * complaint.
 *
 * This is not hypothetical. The timer originally used `--color-success` for rest,
 * which is correct under `navy` (accent #3498db vs. success #27ae60) but collapses
 * under `iron`, where the accent IS green — both resolved to #22c55e, making a
 * working set and a rest indistinguishable at a glance. `--color-rest` exists to
 * break that tie, and this guard is what stops it reappearing when a theme is
 * added or an accent retuned. See #958 / ADR-035.
 *
 * Both halves of that pairing are read from source, never assumed:
 *
 *   1. Which custom property each phase is painted with comes from
 *      TimerDial.module.css — the stylesheet that actually strokes the ring.
 *      Hardcoding that map here would let someone repoint `.rest` back at
 *      `--color-success` and still pass, which is the original bug exactly.
 *   2. What each property resolves to comes from globals.css, read last-wins so
 *      a later redeclaration (e.g. inside a media query) is what gets compared,
 *      matching how the cascade actually resolves it.
 *
 * Usage: node scripts/check-timer-phase-colors.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

/**
 * The four states the dial can paint, per TimerDial.tsx's phase -> class chain.
 *
 * This is a contract (the dial has exactly these four states), not a duplicated
 * value — the *colors* are derived from source below.
 */
export const DIAL_PHASES = ['set', 'rest', 'prep', 'overrun'];

// --- Pure parsing helpers (exported for unit testing) ---

/**
 * Maps each dial phase to the custom property TimerDial.module.css strokes it
 * with, read from that stylesheet rather than assumed.
 *
 * Returns `{ tokens, problems }`. A phase whose class is missing, or which
 * strokes a literal color instead of a `var(--…)`, is reported as a problem
 * rather than silently skipped — a phase this cannot resolve is a phase the
 * guard would otherwise stop checking.
 */
export function readDialTokens(dialCss) {
  const tokens = {};
  const problems = [];

  for (const phase of DIAL_PHASES) {
    // Match `.<phase> { … }` and pull its stroke declaration.
    const rule = dialCss.match(new RegExp(`\\.${phase}\\s*\\{([^}]*)\\}`));
    if (!rule) {
      problems.push(`.${phase} has no rule in TimerDial.module.css`);
      continue;
    }
    const stroke = rule[1].match(/stroke\s*:\s*([^;}]+)/);
    if (!stroke) {
      problems.push(`.${phase} declares no stroke in TimerDial.module.css`);
      continue;
    }
    const value = stroke[1].trim();
    const varName = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (!varName) {
      problems.push(
        `.${phase} strokes a literal (${value}) rather than a custom property, ` +
          'so it cannot be theme-checked',
      );
      continue;
    }
    tokens[phase] = varName[1];
  }

  return { tokens, problems };
}

/**
 * Extracts each theme's declaration block, keyed by theme name.
 *
 * Matches `[data-theme="<name>"] { … }` selectors, including the default block
 * that pairs `:root` with `[data-theme="navy"]`. A theme can legitimately appear
 * more than once (e.g. inside a media query); the bodies are concatenated in
 * source order, and `readPhaseColors` then takes the LAST declaration of each
 * token — which is the one the cascade resolves to.
 */
export function extractThemeBlocks(css) {
  const blocks = {};
  const selector = /(?:^|\})([^{}]*\[data-theme="([\w-]+)"\][^{}]*)\{([^}]*)\}/gm;
  let match;
  while ((match = selector.exec(css)) !== null) {
    const [, , theme, body] = match;
    blocks[theme] = (blocks[theme] ?? '') + body;
  }
  return blocks;
}

/** Every distinct theme name appearing in a `[data-theme="…"]` selector. */
export function declaredThemeNames(css) {
  const names = new Set();
  for (const [, name] of css.matchAll(/\[data-theme="([^"]+)"\]/g)) names.add(name);
  return [...names];
}

/**
 * Reads each phase's color out of one theme's declaration body.
 *
 * Takes the LAST declaration of each token, since a later one wins in the
 * cascade. The terminator is optional so a final declaration written without a
 * trailing semicolon (legal CSS) reads as present rather than missing.
 */
export function readPhaseColors(body, tokens) {
  const colors = {};
  for (const [phase, token] of Object.entries(tokens)) {
    const found = [...body.matchAll(new RegExp(`${token}\\s*:\\s*([^;}]+)[;}]?`, 'g'))];
    const last = found[found.length - 1];
    colors[phase] = last ? last[1].trim() : null;
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

function fail(lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cssPath = resolve(repoRoot, 'apps/web/app/globals.css');
  const dialPath = resolve(repoRoot, 'apps/web/components/timer/TimerDial.module.css');
  const css = readFileSync(cssPath, 'utf8');
  const dialCss = readFileSync(dialPath, 'utf8');

  // Half 1: which token paints each phase, per the dial's own stylesheet.
  const { tokens, problems } = readDialTokens(dialCss);
  if (problems.length > 0) {
    fail([
      'FAIL: cannot resolve the dial phase colors from TimerDial.module.css.\n',
      ...problems.map((p) => `  ${p}`),
      '\nEach of .set/.rest/.prep/.overrun must stroke a var(--custom-property)',
      'so this guard can check it against every theme.',
    ]);
  }

  const blocks = extractThemeBlocks(css);
  const themes = Object.keys(blocks);
  const declared = declaredThemeNames(css);

  // An extraction that silently found nothing would compare an empty set and
  // "pass" — assert the corpus is non-empty separately from the comparison.
  if (themes.length === 0) {
    fail([
      'FAIL: no [data-theme="…"] blocks found in apps/web/app/globals.css.',
      '      That is a vacuous pass, not a clean one — the selector shape likely changed.',
    ]);
  }

  // A *partial* extraction passes the non-empty check above while silently
  // skipping a theme, so assert we matched every theme the file declares.
  const skipped = declared.filter((name) => !themes.includes(name));
  if (skipped.length > 0) {
    fail([
      `FAIL: ${skipped.length} theme(s) declared in globals.css were not extracted: ` +
        `${skipped.join(', ')}.`,
      '      They would be silently unchecked — that is a partial vacuous pass.',
      '      The selector pattern in extractThemeBlocks likely needs widening.',
    ]);
  }

  const failures = [];
  for (const theme of themes) {
    const colors = readPhaseColors(blocks[theme], tokens);
    const { missing, collisions } = findConflicts(colors);

    if (missing.length > 0) {
      failures.push(
        `  [data-theme="${theme}"] does not define: ` +
          missing.map((p) => `${tokens[p]} (${p})`).join(', '),
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
    fail([
      'FAIL: rest-timer dial phases are not distinguishable.\n',
      failures.join('\n'),
      '\nEach theme must give set/rest/prep/overrun four different colors.',
      'See #958 and docs/adr/ADR-035-client-side-rest-timer-state.md.',
    ]);
  }

  const painted = DIAL_PHASES.map((p) => `${p}=${tokens[p]}`).join(', ');
  console.log(
    `OK: rest-timer dial phases are distinct in all ${themes.length} theme(s) ` +
      `(${themes.join(', ')}); dial paints ${painted}.`,
  );
  process.exit(0);
}

// Only run when executed directly, so the pure helpers above can be imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
