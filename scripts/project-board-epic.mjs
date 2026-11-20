#!/usr/bin/env node
/**
 * Maps an issue's `epic:<slug>` label to the Lifting Logbook project board's Epic option ID.
 * Used by .github/workflows/project-board.yml (#1385).
 *
 * The option IDs are read from .claude/hook-config.json's `epic_options`, the cache that
 * scripts/check-board-id-sync.mjs already keeps in step with CLAUDE.md and .claude/propose.json.
 * The slugs are derived from the Epic names, so there is no fourth copy of the IDs to drift.
 *
 * Usage:
 *   ISSUE_LABELS='["bug","epic:operations"]' node scripts/project-board-epic.mjs
 *     Resolves the Epic. Always writes `project_url`, `project_id` and `field_id` to
 *     $GITHUB_OUTPUT, and `option_id` when an `epic:` label matches. Exits 1 on an unknown slug or
 *     more than one `epic:` label. With no `epic:` label it exits 0 and annotates the run.
 *   node scripts/project-board-epic.mjs --list
 *     Prints one `epic:<slug>` label per Epic option, for creating the labels.
 */

import { appendFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

export const HOOK_CONFIG_FILE = '.claude/hook-config.json';
export const LABEL_PREFIX = 'epic:';

/** "Package & App Scaffolding" → "package-and-app-scaffolding"; "CI/CD Foundation" → "ci-cd-foundation". */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Epic option map (name → option ID) → slug → { name, optionId }. Throws if two names share a slug. */
export function epicsBySlug(epicOptions) {
  if (!epicOptions || typeof epicOptions !== 'object' || Object.keys(epicOptions).length === 0) {
    throw new Error(`${HOOK_CONFIG_FILE} has no epic_options`);
  }
  const bySlug = new Map();
  for (const [name, optionId] of Object.entries(epicOptions)) {
    const slug = slugify(name);
    if (bySlug.has(slug)) {
      throw new Error(`Epics "${bySlug.get(slug).name}" and "${name}" both map to the label ${LABEL_PREFIX}${slug}`);
    }
    bySlug.set(slug, { name, optionId });
  }
  return bySlug;
}

/**
 * Resolves an issue's labels against the Epic options.
 * Returns one of:
 *   { status: 'set', slug, name, optionId }
 *   { status: 'none' }                        — no `epic:` label
 *   { status: 'unknown', slugs, validSlugs }  — an `epic:` label matches no Epic
 *   { status: 'multiple', slugs }             — more than one `epic:` label
 */
export function resolveEpic(labels, epicOptions) {
  const bySlug = epicsBySlug(epicOptions);
  const slugs = labels
    .filter((label) => label.toLowerCase().startsWith(LABEL_PREFIX))
    .map((label) => label.slice(LABEL_PREFIX.length).trim().toLowerCase());

  if (slugs.length === 0) return { status: 'none' };
  const unknown = slugs.filter((slug) => !bySlug.has(slug));
  if (unknown.length > 0) return { status: 'unknown', slugs: unknown, validSlugs: [...bySlug.keys()] };
  if (slugs.length > 1) return { status: 'multiple', slugs };
  const { name, optionId } = bySlug.get(slugs[0]);
  return { status: 'set', slug: slugs[0], name, optionId };
}

/** Escapes a workflow-command message, as @actions/core does, so label text can't inject a command. */
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(readFileSync(resolve(root, HOOK_CONFIG_FILE), 'utf8'));

  if (process.argv.includes('--list')) {
    for (const [slug, { name }] of epicsBySlug(config.epic_options)) {
      console.log(`${LABEL_PREFIX}${slug}\t${name}`);
    }
    return 0;
  }

  const labels = JSON.parse(process.env.ISSUE_LABELS ?? '[]');
  if (!Array.isArray(labels)) throw new Error('ISSUE_LABELS must be a JSON array of label names');
  const result = resolveEpic(labels, config.epic_options);

  // The board coordinates are written whatever the label says, so the workflow can still add the
  // issue to the board when this step fails on a bad label. The project is user-owned, hence /users/.
  const write = (lines) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, lines);
  write(
    `project_url=https://github.com/users/${config.project_owner}/projects/${config.project_number}\n` +
      `project_id=${config.project_node_id}\nfield_id=${config.epic_field_id}\n`,
  );

  switch (result.status) {
    case 'none':
      console.log(
        `::notice title=Epic not set::No ${LABEL_PREFIX} label on this issue, so its Epic stays unset. ` +
          'Add one to set it.',
      );
      return 0;
    case 'unknown':
      console.log(
        `::error title=Unknown Epic label::${escapeData(
          `No Epic matches ${result.slugs.map((s) => LABEL_PREFIX + s).join(', ')}. ` +
            `Valid labels: ${result.validSlugs.map((s) => LABEL_PREFIX + s).join(', ')}`,
        )}`,
      );
      return 1;
    case 'multiple':
      console.log(
        `::error title=More than one Epic label::${escapeData(
          `An issue takes one Epic, but it has ${result.slugs.map((s) => LABEL_PREFIX + s).join(', ')}. ` +
            'Remove all but one.',
        )}`,
      );
      return 1;
    case 'set': {
      console.log(`${LABEL_PREFIX}${result.slug} → Epic "${result.name}" (option ${result.optionId})`);
      write(`option_id=${result.optionId}\n`);
      return 0;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
