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
 *   DB connection"). `runSeed` verifies this via `SELECT current_user` and
 *   aborts if the connected role can't see the target program (the classic
 *   failure mode here is running with the *runtime* role's connection
 *   string by mistake, which RLS then hides everything from).
 *
 * Usage:
 *   npx ts-node scripts/seed-tm-history.ts \
 *     --program <target-program-uuid> --user-id <clerk-user-id> \
 *     --input <path-to-GCP_EXPORT_TMHistory.csv> [--dry-run] [--force] [--backup-dir <path>]
 *
 *   npx ts-node scripts/seed-tm-history.ts \
 *     --program <target-program-uuid> --user-id <clerk-user-id> \
 *     --rollback [--dry-run] [--force] [--backup-dir <path>]
 *
 *   npx ts-node scripts/seed-tm-history.ts \
 *     --program <target-program-uuid> --user-id <clerk-user-id> \
 *     --restore <path-to-backup.json> [--dry-run] [--force] [--backup-dir <path>]
 */

import * as fs from 'fs';
import * as os from 'os';
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

interface CommonArgs {
  program: string;
  userId: string;
  dryRun: boolean;
  force: boolean;
  backupDir: string | null;
}

/**
 * Discriminated on `mode` so every call site that branches on it (`runSeed`)
 * gets exhaustiveness checking, and `input`/`restorePath` are only present
 * on the one mode that actually uses them — no `as string` cast needed at
 * either use site (the previous, non-discriminated shape needed one at
 * each), and no way to construct e.g. `{ mode: 'rollback', input: '...' }`.
 */
export type SeedArgs =
  | (CommonArgs & { mode: 'seed'; input: string })
  | (CommonArgs & { mode: 'rollback' })
  | (CommonArgs & { mode: 'restore'; restorePath: string });

export class ArgParseError extends Error {}

const FLAGS_WITH_VALUE = new Set([
  '--program',
  '--user-id',
  '--input',
  '--restore',
  '--backup-dir',
]);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--force', '--rollback']);

/**
 * Strict parser: rejects any token that isn't a recognized `--flag` (or the
 * value immediately following one), rejects a flag passed more than once,
 * and accepts both `--flag value` and `--flag=value` forms. A typo like
 * `--dryrun` or `--dry_run` previously parsed silently as "flag not set" —
 * for `--dry-run` specifically, that meant a mistyped preview request
 * silently became a real destructive write. See the runbook's "Re-run
 * semantics" section for why that distinction matters here more than in a
 * typical CLI.
 */
export function parseArgs(argv: string[]): SeedArgs {
  const values: Partial<Record<string, string>> = {};
  const flags: Partial<Record<string, boolean>> = {};

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i] as string;
    if (!tok.startsWith('--')) {
      throw new ArgParseError(`Unrecognized argument '${tok}' (expected a --flag)`);
    }
    const eqIdx = tok.indexOf('=');
    const flag = eqIdx === -1 ? tok : tok.slice(0, eqIdx);

    if (FLAGS_WITH_VALUE.has(flag)) {
      let value: string;
      if (eqIdx !== -1) {
        value = tok.slice(eqIdx + 1);
        i += 1;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new ArgParseError(`${flag} requires a value`);
        }
        value = next;
        i += 2;
      }
      if (values[flag] !== undefined) {
        throw new ArgParseError(`${flag} was passed more than once`);
      }
      values[flag] = value;
    } else if (BOOLEAN_FLAGS.has(flag)) {
      if (eqIdx !== -1) {
        throw new ArgParseError(`${flag} does not take a value`);
      }
      flags[flag] = true;
      i += 1;
    } else {
      throw new ArgParseError(`Unrecognized flag '${flag}'`);
    }
  }

  const program = values['--program'];
  const userId = values['--user-id'];
  const input = values['--input'];
  const restorePath = values['--restore'];
  const backupDir = values['--backup-dir'] ?? null;
  const dryRun = flags['--dry-run'] ?? false;
  const force = flags['--force'] ?? false;
  const rollback = flags['--rollback'] ?? false;

  if (!program) throw new ArgParseError('--program <uuid> is required');
  if (!userId) throw new ArgParseError('--user-id <clerk-user-id> is required');

  const modeCount = [input !== undefined, rollback, restorePath !== undefined].filter(
    Boolean,
  ).length;
  if (modeCount === 0) {
    throw new ArgParseError(
      'exactly one of --input <path>, --rollback, or --restore <path> is required',
    );
  }
  if (modeCount > 1) {
    throw new ArgParseError(
      '--input, --rollback, and --restore are mutually exclusive — pass exactly one',
    );
  }

  if (rollback) {
    return { mode: 'rollback', program, userId, dryRun, force, backupDir };
  }
  if (restorePath !== undefined) {
    return { mode: 'restore', program, userId, restorePath, dryRun, force, backupDir };
  }
  return { mode: 'seed', program, userId, input: input as string, dryRun, force, backupDir };
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

export const REQUIRED_COLUMNS = [
  'Program',
  'Lift',
  'Cycle Date',
  'TM',
  'Goal Met',
  'Is PR',
  'Will Seed',
];

/**
 * Parses the downloaded `GCP_EXPORT_TMHistory.csv`. Validates the header
 * independently of row count — a header-only or entirely empty file used
 * to skip this check silently (it only ran when `rows.length > 0`) and
 * flow straight into an empty-seed run; see `filterWillSeedRows`'s doc
 * comment for why an empty seed is now refused outright rather than
 * silently treated as a valid "nothing to do" outcome.
 */
export function parseTMHistoryCsv(content: string): TMHistoryCsvRow[] {
  let header: string[] = [];
  const rows = parse(content, {
    columns: (rawHeader: string[]) => {
      header = rawHeader;
      return rawHeader;
    },
    skip_empty_lines: true,
  }) as TMHistoryCsvRow[];

  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `GCP_EXPORT_TMHistory.csv is missing expected column(s): ${missing.join(', ')} — ` +
        `re-export from the Sheet (Logbook Tools → Export TM History (preview))`,
    );
  }
  return rows;
}

/**
 * Parses a `"true"`/`"false"` cell, case-insensitively and with surrounding
 * whitespace trimmed, and throws on anything else. Google Sheets renders a
 * boolean-*looking* cell to CSV export in its own canonical case, which is
 * not guaranteed to match the lowercase `String(booleanValue)` gas-lifting-
 * logbook's export code writes — case-insensitive matching is cheap
 * insurance against that either way. Throwing (rather than defaulting to
 * `false`) on an unrecognized value matters specifically for `Will Seed`:
 * a silent false there previously meant a whole-file format mismatch could
 * make every row look like a hold, producing an empty seed set that then
 * fed a full, successful-looking wipe of the program's history (see
 * `filterWillSeedRows`).
 */
function parseStrictBooleanCell(raw: string | undefined, field: string): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(
    `${field} value ${JSON.stringify(raw ?? '')} is not a recognized boolean (expected "true" or "false", case-insensitive)`,
  );
}

/**
 * Same as {@link parseStrictBooleanCell}, except an empty cell is legitimate
 * and coerces to `false` — used only for `Goal Met`, which `buildTMHistory`
 * on the gas-lifting-logbook side genuinely emits as null/blank when set-1
 * reps or spec reps weren't available for that cycle. `Will Seed` and
 * `Is PR` are never legitimately blank (both non-nullable in the source
 * model), so they use the strict parser instead.
 */
function parseNullableBooleanCell(raw: string | undefined, field: string): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === '') return false;
  return parseStrictBooleanCell(raw, field);
}

/**
 * Rows the write path actually acts on. `Will Seed` is gas-lifting-logbook's
 * single source of truth for this (`TMHistoryRow.willSeed`,
 * `transition !== "hold"`) — this script trusts that column directly and
 * never re-derives the classification itself, matching the contract the
 * runbook and gas-lifting-logbook's validator both document.
 *
 * Uses the strict boolean parser (throws on anything but exactly
 * `true`/`false`, case-insensitive) rather than a loose `=== 'true'`
 * comparison: a loose comparison would silently treat *every* row as a
 * hold if the whole file used a different case or format, producing an
 * empty seed set — and `runSeed` refuses to proceed on an empty seed set
 * specifically because that shape (zero rows to write) is what a
 * plain-append-vs-delete-all-then-append design turns into a full,
 * successful-looking wipe.
 */
export function filterWillSeedRows(rows: TMHistoryCsvRow[]): TMHistoryCsvRow[] {
  return rows.filter((r) => parseStrictBooleanCell(r['Will Seed'], 'Will Seed'));
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a `Cycle Date` cell. Requires the exact `yyyy-MM-dd` shape
 * `TMHistoryRow.cycleDate` is documented to always be (ISO, date-only) and
 * builds the `Date` explicitly via `Date.UTC` — `new Date(str)`'s built-in
 * parser is too permissive two different ways: (1) it accepts locale-
 * formatted strings like `03/01/2026` without complaint, silently
 * transposing month/day versus what gas-lifting-logbook actually derived,
 * and (2) even for a correctly-ISO string, JS parses a date-only ISO string
 * as **UTC** midnight but would parse an equivalent slash-formatted string
 * as **local** midnight — a real day could shift depending on which shape
 * showed up, for any reader west of UTC. These dates are the ordering key
 * for the seeded history, so a silent day-shift is a real correctness bug,
 * not a cosmetic one.
 */
function parseCycleDate(raw: string | undefined, field = 'Cycle Date'): Date {
  const value = (raw ?? '').trim();
  const match = ISO_DATE_ONLY.exec(value);
  if (!match) {
    throw new Error(
      `${field} value ${JSON.stringify(raw ?? '')} is not in yyyy-MM-dd format`,
    );
  }
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime())) {
    throw new Error(`${field} value ${JSON.stringify(raw ?? '')} is not a valid date`);
  }
  return date;
}

/**
 * Maps one CSV row to an `appendHistoryEntries` entry. Field mapping
 * matches the runbook's table ("Step 4 — Field mapping") exactly — see
 * that table for the `reps`/`source`/`Goal Met` rationale, unchanged here.
 *
 * `TM` is validated as non-empty and a positive finite number: `Number('')`
 * and `Number('   ')` are `0`, not `NaN`, so a blank cell previously passed
 * an `isNaN`-only guard and seeded `weight: 0` into a non-null column. This
 * is the last check before a direct DB write on an RLS-bypassing
 * connection — gas-lifting-logbook's own pre-flight validator runs against
 * the Sheet tab, not this downloaded CSV, so it does not cover this input.
 */
export function mapRowToEntry(
  row: TMHistoryCsvRow,
): Omit<TrainingMaxHistoryEntry, 'id'> {
  const tmRaw = (row['TM'] ?? '').trim();
  if (!tmRaw) {
    throw new Error('Row has an empty TM');
  }
  const weight = Number(tmRaw);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Row has an invalid TM: ${JSON.stringify(row['TM'])}`);
  }
  const date = parseCycleDate(row['Cycle Date']);
  return {
    lift: resolveLiftId((row['Lift'] ?? '').trim()),
    weight,
    reps: 1,
    date,
    isPR: parseStrictBooleanCell(row['Is PR'], 'Is PR'),
    source: 'program',
    goalMet: parseNullableBooleanCell(row['Goal Met'], 'Goal Met'),
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

/**
 * Confirms `DATABASE_URL` is actually the migrator/owner role before
 * interpreting `findUnique`'s result — a `null` result is ambiguous between
 * "no such program" and "RLS is hiding it because this connection is the
 * restricted runtime role, not the migrator one." Given the script's whole
 * premise is a *manually established* break-glass connection, that mix-up
 * is a realistic operator error, and the two cases warrant different next
 * steps (fix `--program` vs. fix the connection). Echoes the resolved
 * role/database so the run is auditable from its own output.
 */
export async function verifyProgramOwnership(
  prisma: PrismaClient,
  program: string,
  userId: string,
): Promise<void> {
  const [identity] = await prisma.$queryRaw<
    Array<{ current_user: string; current_database: string }>
  >`SELECT current_user, current_database()`;
  console.log(
    `Connected as ${identity?.current_user ?? '(unknown)'} on database ${identity?.current_database ?? '(unknown)'}.`,
  );

  const row = await prisma.customProgram.findUnique({ where: { id: program } });
  if (!row) {
    throw new ProgramOwnershipError(
      `Program '${program}' does not exist — or exists but is invisible on this connection. ` +
        `If you're certain the UUID is correct, confirm DATABASE_URL is the migrator/owner role, ` +
        `not the restricted runtime role (RLS silently hides rows from the latter).`,
    );
  }
  if (row.userId !== userId) {
    throw new ProgramOwnershipError(
      `Program '${program}' belongs to a different user than --user-id='${userId}' — ` +
        `refusing to write or delete. Double-check --program before retrying; this ` +
        `check exists because the migrator/owner role bypasses Row-Level Security, ` +
        `so it is the only tenant-isolation control this script has.`,
    );
  }

  // Defense in depth beyond the program-level check above: the delete and
  // append below are scoped by (program, userId) through the repository,
  // not by program alone. If training_max_history somehow held rows for
  // this program under a *different* userId than the one that owns
  // customProgram (a data-integrity anomaly, not a normal state), those
  // rows would be invisible to the user-scoped count/backup/delete below —
  // undercounting existingCount (so --force never fires) while the append
  // still adds a new, overlapping series. This connection is the only one
  // in the system that can see such rows at all, so it's the only place
  // this check is possible — and it's cheap.
  const programScopedCount = await prisma.trainingMaxHistory.count({
    where: { program },
  });
  const userScopedCount = await prisma.trainingMaxHistory.count({
    where: { program, userId },
  });
  if (programScopedCount !== userScopedCount) {
    throw new ProgramOwnershipError(
      `Program '${program}' has ${programScopedCount} history row(s) total but only ` +
        `${userScopedCount} belong to --user-id='${userId}' — some rows exist under a ` +
        `different userId for this same program, which this script cannot safely resolve. ` +
        `Investigate directly before proceeding.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Backup (ADR-079 back-up-before-mutate — see the runbook's "Re-run
// semantics" section for why this always runs before any delete) and
// restore (the other half of that convention: an idempotent path back to
// the captured state, not just a generic reset).
// ---------------------------------------------------------------------------

const DEFAULT_BACKUP_DIR = path.join(os.tmpdir(), 'lifting-logbook-tm-history-backups');

export function backupFilePath(outDir: string, program: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(outDir, `tm-history-backup-${program}-${stamp}.json`);
}

/**
 * Writes existing history to a local JSON file, verifies the write by
 * reading it back and comparing row counts (a corrupt or truncated write —
 * disk full mid-write, process killed — would otherwise go unnoticed right
 * up until the moment it's needed for recovery), and returns its path.
 * Defaults outside the repo working tree (`os.tmpdir()`-based) rather than
 * `process.cwd()` — the previous default landed the backup, a full dump of
 * one user's training-max history keyed to their Clerk id, as an untracked
 * file inside `apps/api/`, one `git add .` away from being committed.
 * Override with `--backup-dir` when a specific location is wanted.
 */
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
  const serialized = JSON.stringify(existing, null, 2);
  fs.writeFileSync(filePath, serialized);

  const readBack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(readBack) || readBack.length !== existing.length) {
    throw new Error(
      `Backup verification failed for ${filePath}: wrote ${existing.length} row(s) but ` +
        `read back ${Array.isArray(readBack) ? readBack.length : 'non-array data'}. ` +
        `Refusing to proceed with any delete until this is resolved.`,
    );
  }
  return { path: filePath, count: existing.length };
}

/** Reads a backup file written by {@link backupExistingHistory} and strips `id` for re-append. */
function readBackupFile(restorePath: string): Omit<TrainingMaxHistoryEntry, 'id'>[] {
  const raw = fs.readFileSync(restorePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${restorePath} does not contain a JSON array — not a valid backup file`);
  }
  return (parsed as TrainingMaxHistoryEntry[]).map(({ id: _id, ...rest }) => ({
    ...rest,
    date: new Date(rest.date),
  }));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type SeedMode = 'dry-run' | 'seeded' | 'rolled-back' | 'restored';

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
 * Runs the seed, rollback, or restore. Re-run semantics match the runbook
 * exactly: normal mode is delete-all-then-append (never plain append —
 * `training_max_history` has no unique constraint), gated by `--force`
 * whenever pre-existing history is found (unexpected at the normal Phase 2B
 * timing — see the runbook). `--dry-run` never enforces the `--force` gate
 * itself — it always succeeds and reports whether `--force` would be
 * needed, and now also runs the *same* row mapping/validation the real run
 * would (previously it stopped at a row count, so a CSV that would fail
 * `mapRowToEntry` passed dry-run cleanly and only failed on the real,
 * already-destructive run).
 *
 * The delete and append (or the rollback delete, or the restore's
 * delete-then-append) run inside one `prisma.$transaction` — previously two
 * independent statements, so a failure between them (a dropped break-glass
 * connection, a constraint violation) left the program's history fully
 * deleted with no automatic recovery. The `as PrismaClient` cast below on
 * the transaction client mirrors this codebase's own established pattern
 * for constructing a repository over a transaction client — see
 * `prisma-repository-factory.ts`'s `client()`, which does the identical
 * cast for the same structural reason (a transaction client is call-
 * compatible for repository purposes but not identical to the full
 * `PrismaClient` type).
 */
export async function runSeed(
  prisma: PrismaClient,
  args: SeedArgs,
  backupDirOverride?: string,
): Promise<SeedResult> {
  await verifyProgramOwnership(prisma, args.program, args.userId);
  const backupDir = backupDirOverride ?? args.backupDir ?? DEFAULT_BACKUP_DIR;
  const repo = new PrismaTrainingMaxHistoryRepository(prisma, args.userId);

  const existing = await repo.getHistory(args.program);
  const existingCount = existing.length;
  const forceRequired = existingCount > 0;

  // Pre-compute what a real run would write, for both the dry-run report
  // and (below) the actual write — validated identically either way, so a
  // dry run is a genuine full rehearsal of everything except the two
  // mutating calls.
  let entries: Omit<TrainingMaxHistoryEntry, 'id'>[] = [];
  if (args.mode === 'seed') {
    entries = filterWillSeedRows(
      parseTMHistoryCsv(fs.readFileSync(args.input, 'utf8')),
    ).map(mapRowToEntry);
    if (entries.length === 0) {
      throw new Error(
        'The export produced zero rows to seed (Will Seed=true). A zero-row seed is never ' +
          'a legitimate outcome for this script — check --input is the correct, current export, ' +
          'and that the source Sheet actually has data to derive from.',
      );
    }
  } else if (args.mode === 'restore') {
    entries = readBackupFile(args.restorePath);
  }

  if (args.dryRun) {
    return {
      mode: 'dry-run',
      program: args.program,
      existingCount,
      forceRequired,
      writtenCount: args.mode === 'rollback' ? 0 : entries.length,
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
    if (backupPath) {
      // Disclosed immediately, not only in the final success summary — this
      // is the sole recovery artifact if the transaction below still fails
      // for a reason a DB transaction can't protect against (e.g. the
      // process being killed), so it must be visible on the failure path
      // too, not just on success.
      console.log(`Backed up ${backup?.count} existing row(s) to ${backupPath}`);
    }
  }

  const writtenCount = await prisma.$transaction(async (tx) => {
    // See this function's doc comment for why this cast mirrors an
    // existing, accepted pattern in this codebase rather than being a
    // one-off suppression.
    const txRepo = new PrismaTrainingMaxHistoryRepository(
      tx as PrismaClient,
      args.userId,
    );
    await txRepo.deleteAllHistory(args.program);
    if (args.mode !== 'rollback') {
      await txRepo.appendHistoryEntries(args.program, entries);
    }
    return args.mode === 'rollback' ? 0 : entries.length;
  });

  return {
    mode: args.mode === 'rollback' ? 'rolled-back' : args.mode === 'restore' ? 'restored' : 'seeded',
    program: args.program,
    existingCount,
    forceRequired,
    writtenCount,
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
  } else if (result.mode === 'restored') {
    lines.push(
      `Restored — deleted ${result.existingCount} row(s), wrote ${result.writtenCount} row(s) from backup.`,
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
  console.log(
    `Mode: ${args.mode === 'seed' ? (args.dryRun ? 'DRY RUN (no writes)' : 'REAL WRITE') : args.mode.toUpperCase()}` +
      (args.dryRun && args.mode !== 'seed' ? ' (DRY RUN — no writes)' : ''),
  );
  if (args.mode === 'seed') {
    // Fail fast on a bad --input before any DB round trip.
    if (!fs.existsSync(args.input)) {
      throw new Error(
        `--input path does not exist: ${path.resolve(args.input)}. Re-export from the ` +
          `Sheet (Logbook Tools → Export TM History (preview)) and download it as CSV.`,
      );
    }
  }
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
    // process.exitCode (not process.exit()) lets pending stdio writes flush
    // before the process actually exits — process.exit() can truncate the
    // final error line when stderr is a pipe (e.g. `... | tee seed.log`,
    // exactly what an auditable break-glass run would use).
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  });
}
