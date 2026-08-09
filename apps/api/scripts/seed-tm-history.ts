/**
 * Phase 2B one-time seeding script — writes gas-lifting-logbook's derived,
 * human-approved `GCP_EXPORT_TMHistory.csv` into `training_max_history` via
 * `ITrainingMaxHistoryRepository`, run as the migrator/owner role (bypasses
 * RLS) through the break-glass connection established per
 * gas-lifting-logbook's `docs/phase2b-tm-history-seeding-runbook.md`.
 *
 * Tracked in issue #885 (companion to gas-lifting-logbook#23/#4). Read that
 * runbook before running this for real — it's the full human-executed
 * procedure (export, validate, review, connect, verify ownership, tear
 * down), of which this script implements only the "Dry run, then the real
 * seed" and "Rollback / redo" steps. This file exists to implement that
 * documented contract exactly, not to redefine it — if the two ever
 * disagree, treat it as a bug in one of them, not an ambiguity to resolve
 * ad hoc.
 *
 * Prerequisites this script assumes (see the runbook for the human steps):
 * - `packages/core` and `packages/types` have both been built
 *   (`npm run build -w @lifting-logbook/core -w @lifting-logbook/types`, or
 *   the root `npm run build`) — their compiled `dist/` output is what this
 *   script's `@lifting-logbook/core` import (and `apps/api`'s own compile)
 *   resolves to under plain `ts-node` (unlike Jest, which maps straight to
 *   `src/` — see `apps/api/jest.config.js`'s moduleNameMapper comment for
 *   why: workspace packages resolve to `dist` outside Jest). A fresh clone
 *   or worktree needs this step once; `npm install`'s own postinstall does
 *   not build workspace packages.
 * - `DATABASE_URL` is exported and points at the migrator/owner role,
 *   through the break-glass connection (runbook "Establish the break-glass
 *   DB connection").
 *
 * Usage:
 *   npx ts-node scripts/seed-tm-history.ts \
 *     --program <target-program-uuid> --user-id <clerk-user-id> \
 *     --input <path-to-GCP_EXPORT_TMHistory.csv> [--dry-run] [--force]
 *
 *   npx ts-node scripts/seed-tm-history.ts \
 *     --program <target-program-uuid> --user-id <clerk-user-id> \
 *     --rollback [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_SLOT_MAP, TrainingMaxHistoryEntry } from '@lifting-logbook/core';
import { ITrainingMaxHistoryRepository } from '../src/ports/ITrainingMaxHistoryRepository';
import { PrismaTrainingMaxHistoryRepository } from '../src/adapters/prisma/training-max-history.repository';

// ---------------------------------------------------------------------------
// CLI argument parsing (pure — no fs/DB access, so this is directly
// unit-testable without any mocking).
// ---------------------------------------------------------------------------

export interface SeedArgs {
  program: string;
  userId: string;
  /** Required unless rollback is true; null when rollback is true. */
  input: string | null;
  dryRun: boolean;
  force: boolean;
  rollback: boolean;
}

export class ArgParseError extends Error {}

export function parseArgs(argv: string[]): SeedArgs {
  const getValue = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ArgParseError(`${flag} requires a value`);
    }
    return value;
  };
  const hasFlag = (flag: string): boolean => argv.includes(flag);

  const program = getValue('--program');
  const userId = getValue('--user-id');
  const input = getValue('--input');
  const dryRun = hasFlag('--dry-run');
  const force = hasFlag('--force');
  const rollback = hasFlag('--rollback');

  if (!program) throw new ArgParseError('--program <uuid> is required');
  if (!userId) throw new ArgParseError('--user-id <clerk-user-id> is required');
  if (!rollback && !input) {
    throw new ArgParseError(
      '--input <path-to-csv> is required unless --rollback is passed',
    );
  }
  if (rollback && input) {
    throw new ArgParseError(
      '--input is not used with --rollback — rollback only deletes, it never re-seeds from a CSV',
    );
  }

  return { program, userId, input, dryRun, force, rollback };
}

// ---------------------------------------------------------------------------
// Lift resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a GAS-side lift name to the target's canonical lift id string,
 * passing an unresolved name through verbatim. Deliberately **not** the
 * catalog's own `resolveLift` (`packages/core/src/catalog/resolve.ts`) —
 * that function has different semantics for a different purpose: it throws
 * on an unmapped slot name (right for validating a program spec against a
 * known catalog) and returns a full `Lift` catalog object, not an id
 * string. This script instead matches the passthrough behavior the import
 * path already uses for training-maxes (`slotMap[lift] ?? lift`) — an
 * unresolved historical lift name should still seed with whatever string
 * gas-lifting-logbook derived it as, not abort the whole run. Named
 * `resolveLiftId` (not `resolveLift`) specifically so it's never confused
 * with the catalog function at a glance. Unlike gas-lifting-logbook's own
 * validator, which mirrors a hand-copied, drift-documented snapshot of this
 * map (`gcpTargetImportRules.ts`), this script imports the real
 * `DEFAULT_SLOT_MAP` directly — no mirror, no drift risk.
 */
export function resolveLiftId(lift: string): string {
  return DEFAULT_SLOT_MAP[lift] ?? lift;
}

// ---------------------------------------------------------------------------
// CSV parsing + row mapping (pure — unit-testable without fs/DB access).
// ---------------------------------------------------------------------------

export type TMHistoryCsvRow = Record<string, string>;

const REQUIRED_COLUMNS = [
  'Program',
  'Lift',
  'Cycle Date',
  'TM',
  'Goal Met',
  'Is PR',
  'Will Seed',
];

/**
 * Parses the downloaded `GCP_EXPORT_TMHistory.csv`. Throws with an
 * actionable message (not a generic csv-parse error) if the expected
 * columns aren't present — the most likely cause is a stale or
 * hand-truncated export.
 */
export function parseTMHistoryCsv(content: string): TMHistoryCsvRow[] {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
  }) as TMHistoryCsvRow[];

  if (rows.length > 0) {
    const first = rows[0] as TMHistoryCsvRow;
    const missing = REQUIRED_COLUMNS.filter((c) => !(c in first));
    if (missing.length > 0) {
      throw new Error(
        `GCP_EXPORT_TMHistory.csv is missing expected column(s): ${missing.join(', ')} — ` +
          `re-export from the Sheet (Logbook Tools → Export TM History (preview))`,
      );
    }
  }
  return rows;
}

/**
 * Rows the write path actually acts on. `Will Seed` is gas-lifting-logbook's
 * single source of truth for this (`TMHistoryRow.willSeed`,
 * `transition !== "hold"`) — this script trusts that column directly and
 * never re-derives the classification itself, matching the contract the
 * runbook and gas-lifting-logbook's validator both document.
 */
export function filterWillSeedRows(rows: TMHistoryCsvRow[]): TMHistoryCsvRow[] {
  return rows.filter((r) => r['Will Seed'] === 'true');
}

function parseBooleanCell(raw: string | undefined): boolean {
  return raw === 'true';
}

/**
 * Maps one CSV row to an `appendHistoryEntries` entry. Field mapping
 * matches the runbook's table ("Step 4 — Field mapping") exactly:
 * - `reps` is always `1` — matches `CycleGenerationService.buildHistoryEntries`'s
 *   convention: a training-max value, not a logged set.
 * - `source` is always `'program'` — RPT has no test-week concept; the
 *   target's DB CHECK constraint on `training_max_history.source` only
 *   accepts `'test'` or `'program'` regardless.
 * - `Is PR` is taken as-is; a blank cell is never legitimate here (`isPR` is
 *   non-nullable in the source model, and gas-lifting-logbook's own
 *   pre-flight validator blocks an empty `Is PR` cell before this script
 *   would ever see one) — `parseBooleanCell` intentionally has no special
 *   handling for that case, so a row that slipped through unvalidated maps
 *   an empty/garbage `Is PR` to `false` rather than throwing, matching this
 *   function's general lenient-parse posture (validation is the pre-flight
 *   validator's job, not this mapper's).
 * - `Goal Met` coerces a blank cell to `false` — the target's `goalMet`
 *   column is a non-null `Boolean` with `@default(false)`, and a blank cell
 *   here is a real, expected state (unlike `Is PR`): `buildTMHistory`
 *   genuinely emits `goalMet: null` whenever set-1 reps or spec reps weren't
 *   available for that cycle. `parseBooleanCell`'s `raw === 'true'` check
 *   already coerces both `''` and `'false'` to `false` identically, which is
 *   exactly the coercion the runbook documents — no extra branching needed.
 */
export function mapRowToEntry(
  row: TMHistoryCsvRow,
): Omit<TrainingMaxHistoryEntry, 'id'> {
  const weight = Number(row['TM']);
  const date = new Date(row['Cycle Date'] as string);
  if (isNaN(weight)) {
    throw new Error(`Row has a non-numeric TM: ${JSON.stringify(row)}`);
  }
  if (isNaN(date.getTime())) {
    throw new Error(`Row has an invalid Cycle Date: ${JSON.stringify(row)}`);
  }
  return {
    lift: resolveLiftId((row['Lift'] ?? '').trim()),
    weight,
    reps: 1,
    date,
    isPR: parseBooleanCell(row['Is PR']),
    source: 'program',
    goalMet: parseBooleanCell(row['Goal Met']),
  };
}

// ---------------------------------------------------------------------------
// Program-ownership verification — security requirement added during
// gas-lifting-logbook PR #24's /review (see issue #885's review-comment
// addendum and the runbook's "Verify program ownership" step). Because this
// script connects as the migrator/owner role specifically to bypass RLS,
// `--program` is the *only* tenant-isolation control left on both the seed
// write and --rollback's delete — there is no database-level check behind
// it the way RLS normally provides. This function is that check.
// ---------------------------------------------------------------------------

export class ProgramOwnershipError extends Error {}

export async function verifyProgramOwnership(
  prisma: PrismaClient,
  program: string,
  userId: string,
): Promise<void> {
  const row = await prisma.customProgram.findUnique({ where: { id: program } });
  if (!row) {
    throw new ProgramOwnershipError(`Program '${program}' does not exist`);
  }
  if (row.userId !== userId) {
    throw new ProgramOwnershipError(
      `Program '${program}' belongs to a different user than --user-id='${userId}' — ` +
        `refusing to write or delete. Double-check --program before retrying; this ` +
        `check exists because the migrator/owner role bypasses Row-Level Security, ` +
        `so it is the only tenant-isolation control this script has.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Backup (ADR-079 back-up-before-mutate — see the runbook's "Re-run
// semantics" section for why this always runs before any delete).
// ---------------------------------------------------------------------------

export function backupFilePath(outDir: string, program: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(outDir, `tm-history-backup-${program}-${stamp}.json`);
}

export async function backupExistingHistory(
  repo: ITrainingMaxHistoryRepository,
  program: string,
  outDir: string,
  now: Date = new Date(),
): Promise<{ path: string; count: number } | null> {
  const existing = await repo.getHistory(program);
  if (existing.length === 0) return null;
  const filePath = backupFilePath(outDir, program, now);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  return { path: filePath, count: existing.length };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type SeedMode = 'dry-run' | 'seeded' | 'rolled-back';

export interface SeedResult {
  mode: SeedMode;
  program: string;
  existingCount: number;
  /** Whether --force would be (or was) required given existingCount. */
  forceRequired: boolean;
  writtenCount: number;
  backupPath: string | null;
}

/**
 * Runs the seed (or rollback). Re-run semantics match the runbook exactly:
 * normal mode is delete-all-then-append (never plain append —
 * `training_max_history` has no unique constraint), gated by `--force`
 * whenever pre-existing history is found (unexpected at the normal Phase 2B
 * timing — see the runbook). `--dry-run` never touches the database beyond
 * the read-only `getHistory` call already needed to report `existingCount`
 * — it never enforces the `--force` gate itself, so a dry run always
 * succeeds and reports whether `--force` would be needed, rather than
 * failing before the operator has a chance to see that.
 */
export async function runSeed(
  prisma: PrismaClient,
  args: SeedArgs,
  backupDir: string = process.cwd(),
): Promise<SeedResult> {
  await verifyProgramOwnership(prisma, args.program, args.userId);
  const repo = new PrismaTrainingMaxHistoryRepository(prisma, args.userId);

  const existing = await repo.getHistory(args.program);
  const existingCount = existing.length;
  const forceRequired = existingCount > 0;

  if (args.dryRun) {
    const writtenCount = args.rollback
      ? 0
      : filterWillSeedRows(
          parseTMHistoryCsv(fs.readFileSync(args.input as string, 'utf8')),
        ).length;
    return {
      mode: 'dry-run',
      program: args.program,
      existingCount,
      forceRequired,
      writtenCount,
      backupPath: null,
    };
  }

  if (forceRequired && !args.force) {
    throw new Error(
      `Program '${args.program}' already has ${existingCount} history row(s). ` +
        `This is unexpected at the normal Phase 2B timing — double-check --program ` +
        `is the intended program before proceeding. Pass --force to confirm and ` +
        `continue (this will delete those ${existingCount} row(s); a backup is ` +
        `written first either way).`,
    );
  }

  let backupPath: string | null = null;
  if (existingCount > 0) {
    const backup = await backupExistingHistory(repo, args.program, backupDir);
    backupPath = backup?.path ?? null;
  }

  if (args.rollback) {
    await repo.deleteAllHistory(args.program);
    return {
      mode: 'rolled-back',
      program: args.program,
      existingCount,
      forceRequired,
      writtenCount: 0,
      backupPath,
    };
  }

  const entries = filterWillSeedRows(
    parseTMHistoryCsv(fs.readFileSync(args.input as string, 'utf8')),
  ).map(mapRowToEntry);

  await repo.deleteAllHistory(args.program);
  await repo.appendHistoryEntries(args.program, entries);

  return {
    mode: 'seeded',
    program: args.program,
    existingCount,
    forceRequired,
    writtenCount: entries.length,
    backupPath,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

export function formatResult(result: SeedResult): string {
  const lines = [`Program: ${result.program}`];
  lines.push(
    `Pre-existing history rows: ${result.existingCount}` +
      (result.backupPath ? ` (backed up to ${result.backupPath})` : ''),
  );
  if (result.mode === 'dry-run') {
    lines.push(
      `DRY RUN — nothing was written. Would delete ${result.existingCount} row(s)` +
        (result.forceRequired ? ' (would require --force)' : '') +
        ` and write ${result.writtenCount} row(s).`,
    );
  } else if (result.mode === 'rolled-back') {
    lines.push(
      `Rolled back — deleted ${result.existingCount} row(s), wrote 0 (no re-seed).`,
    );
  } else {
    lines.push(
      `Seeded — deleted ${result.existingCount} row(s), wrote ${result.writtenCount} row(s).`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const result = await runSeed(prisma, args);
    console.log(formatResult(result));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
