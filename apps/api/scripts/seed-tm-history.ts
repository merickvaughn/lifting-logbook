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
 *   or worktree needs this step once; `npm install`'s postinstall does
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
 *
 *   npx ts-node scripts/seed-tm-history.ts --help
 *
 * Backups are written as a JSON envelope (`{ program, userId, capturedAt,
 * entries }`, not a bare array) so `--restore` can refuse to restore across
 * programs or users — see `readBackupFile`'s doc comment.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_SLOT_MAP, TrainingMaxHistoryEntry } from '@lifting-logbook/core';
import { PrismaTrainingMaxHistoryRepository } from '../src/adapters/prisma/training-max-history.repository';
import { runInteractive, IMPORT_BATCH_TX_OPTIONS } from '../src/adapters/prisma/prisma-tx.util';

const USAGE = `Usage:
  npx ts-node scripts/seed-tm-history.ts --program <uuid> --user-id <id> --input <path> [--dry-run] [--force] [--backup-dir <path>]
  npx ts-node scripts/seed-tm-history.ts --program <uuid> --user-id <id> --rollback [--dry-run] [--force] [--backup-dir <path>]
  npx ts-node scripts/seed-tm-history.ts --program <uuid> --user-id <id> --restore <path> [--dry-run] [--force] [--backup-dir <path>]

See docs/phase2b-tm-history-seeding-runbook.md (gas-lifting-logbook repo) for the full human-executed procedure this script is one step of.`;

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
 * either use site.
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
 * typical CLI. `--help`/`-h` are handled in `main()` before this is ever
 * called, so they are not part of this parser's flag vocabulary.
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
  if (input !== undefined) {
    return { mode: 'seed', program, userId, input, dryRun, force, backupDir };
  }
  // Unreachable: modeCount === 1 above guarantees exactly one of
  // rollback/restorePath/input is set, and the first two branches handle
  // the other two. Present only so TypeScript sees every path return.
  throw new ArgParseError('unreachable: no seed mode matched');
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
 *
 * `bom: true` strips a leading UTF-8 byte-order mark, and header names are
 * trimmed before the `REQUIRED_COLUMNS` comparison (and before they become
 * the row object's own keys) — a human is expected to open this file in a
 * spreadsheet tool to eyeball it before running the script (the runbook's
 * Step 3), and a BOM or stray trailing space surviving that round trip
 * would otherwise fail with "missing expected column(s)" even though the
 * column is right there, visibly, when the operator re-opens the file.
 */
export function parseTMHistoryCsv(content: string): TMHistoryCsvRow[] {
  let header: string[] = [];
  const rows = parse(content, {
    bom: true,
    columns: (rawHeader: string[]) => {
      header = rawHeader.map((h) => h.trim());
      return header;
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

/**
 * Cross-row invariant mirroring gas-lifting-logbook's own pre-flight
 * validator (`docs/phase2b-tm-history-seeding-runbook.md` Step 2's
 * "blocking" multi-program check). That validator runs against the live
 * Sheet tab, not this downloaded CSV, so nothing guarantees the two are
 * the same vintage — the same reasoning `mapRowToEntry`'s doc comment
 * gives for re-validating `TM`, applied here to a cross-row invariant
 * instead of a per-cell one. `program` scoping for the actual write is
 * always the `--program` CLI argument, never this column (see the
 * runbook's Field mapping table) — this check exists only to catch a CSV
 * that mixes rows from more than one program, which `--program` alone
 * can't detect, before they're silently written under the wrong program's
 * UUID.
 */
export function assertSingleProgram(rows: TMHistoryCsvRow[]): void {
  const programs = new Set(
    rows.map((r) => (r['Program'] ?? '').trim()).filter((p) => p !== ''),
  );
  if (programs.size > 1) {
    throw new Error(
      `Will Seed rows span ${programs.size} different Program values ` +
        `(${[...programs].sort().join(', ')}) — this CSV appears to mix more than one ` +
        `program. Re-export from a workbook holding only the program you're seeding, ` +
        `or fix the source data (see the runbook's Step 2).`,
    );
  }
}

/**
 * The other half of gas-lifting-logbook's Step 2 blocking checks, re-applied
 * here for the same reason as {@link assertSingleProgram}: a `(program,
 * lift, cycle date)` collision the Sheet-side validator already rejects,
 * re-checked against this CSV because `training_max_history` has no unique
 * constraint to catch it at the database level. Checked on the *resolved*
 * lift id (post-`resolveLiftId`), not the raw CSV `Lift` string, because
 * that's what would actually collide as two rows for the same cycle in the
 * database — two differently-spelled raw names that resolve to the same
 * target lift are exactly the case a raw-string comparison would miss.
 */
export function assertNoDuplicateSeedKeys(
  entries: Omit<TrainingMaxHistoryEntry, 'id'>[],
): void {
  const seenAt = new Map<string, number>();
  entries.forEach((entry, index) => {
    const dateKey = entry.date.toISOString().slice(0, 10);
    const key = `${entry.lift}::${dateKey}`;
    const firstIndex = seenAt.get(key);
    if (firstIndex !== undefined) {
      throw new Error(
        `Duplicate seed key: lift '${entry.lift}' on ${dateKey} appears more than once ` +
          `among Will Seed=true rows (rows ${firstIndex + 1} and ${index + 1}). ` +
          `training_max_history has no unique constraint, so this would silently write ` +
          `two rows for the same cycle — fix the source data (see the runbook's Step 2).`,
      );
    }
    seenAt.set(key, index);
  });
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
 *
 * Deliberately does not include row context (index, lift, date) in its own
 * error messages — it stays a pure function with a stable, directly
 * unit-testable contract. The seed-time call site in `runSeed` wraps each
 * call and adds that context to the thrown message instead.
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

interface BackupEnvelope {
  program: string;
  userId: string;
  capturedAt: string;
  entries: TrainingMaxHistoryEntry[];
}

/**
 * Writes already-fetched history to a local JSON *envelope* (not a bare
 * array — `program`/`userId`/`capturedAt` travel with the data so
 * `readBackupFile` can refuse to restore it against the wrong program or
 * user), verifies the write by reading it back and comparing row counts,
 * fsyncs before returning, and returns its path. Takes `existing` as an
 * already-fetched array rather than a repository + re-fetching internally:
 * `runSeed` fetches history exactly once now, and passes the same array to
 * both the reported `existingCount` and this backup, so the audit line and
 * the recovery artifact are provably the same snapshot (previously two
 * independent `getHistory` calls, which also made this function trivially
 * DB-free and unit-testable rather than Testcontainers-only).
 *
 * Creates `outDir` (and refuses to proceed if it turns out to already be a
 * symlink) and writes the file with restrictive permissions (`0o700`
 * directory, `0o600` file) — the file is a complete dump of one user's
 * training-max history keyed to their Clerk id (see the `.gitignore`
 * comment for this pattern), and the default location is `os.tmpdir()`,
 * which on a shared multi-user Linux host (a bastion, jump host, or CI
 * runner — plausible venues for break-glass production DB access) is
 * world-readable by default. `mode` is a no-op on Windows (NTFS has no
 * unix permission bits) but a real hardening on Linux/macOS, which is
 * where the exposure actually applies.
 *
 * Defaults outside the repo working tree (`os.tmpdir()`-based) rather than
 * `process.cwd()` — the previous default landed the backup as an untracked
 * file inside `apps/api/`, one `git add .` away from being committed.
 * Override with `--backup-dir` when a specific (and more durable —
 * `os.tmpdir()` is purged on a schedule or at reboot on most platforms)
 * location is wanted.
 */
export async function backupExistingHistory(
  existing: TrainingMaxHistoryEntry[],
  program: string,
  userId: string,
  outDir: string,
  now: Date = new Date(),
): Promise<{ path: string; count: number } | null> {
  if (existing.length === 0) return null;

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(outDir).isSymbolicLink()) {
    throw new Error(
      `Backup directory '${outDir}' is a symlink — refusing to write a sensitive backup ` +
        `(one user's full training-max history) through it. Remove it or pass a different --backup-dir.`,
    );
  }

  const filePath = backupFilePath(outDir, program, now);
  const envelope: BackupEnvelope = {
    program,
    userId,
    capturedAt: now.toISOString(),
    entries: existing,
  };
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), { mode: 0o600 });

  // A same-process read-back proves the bytes are readable, but not that
  // they're durable (both writer and reader can be served from the page
  // cache) — fsync before the verification read closes that gap for the
  // sole recovery artifact this function exists to produce.
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  const readBack = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<BackupEnvelope>;
  if (!Array.isArray(readBack.entries) || readBack.entries.length !== existing.length) {
    throw new Error(
      `Backup verification failed for ${filePath}: wrote ${existing.length} row(s) but ` +
        `read back ${Array.isArray(readBack.entries) ? readBack.entries.length : 'non-array data'}. ` +
        `Refusing to proceed with any delete until this is resolved.`,
    );
  }
  return { path: filePath, count: existing.length };
}

function validateBackupEntry(entry: unknown, index: number): Omit<TrainingMaxHistoryEntry, 'id'> {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Backup entries[${index}] is not an object`);
  }
  const e = entry as Record<string, unknown>;
  const lift = e['lift'];
  if (typeof lift !== 'string' || lift.trim() === '') {
    throw new Error(`Backup entries[${index}] has an invalid lift`);
  }
  const weight = e['weight'];
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Backup entries[${index}] (lift '${lift}') has an invalid weight`);
  }
  const reps = e['reps'];
  if (typeof reps !== 'number' || !Number.isFinite(reps) || reps <= 0) {
    throw new Error(`Backup entries[${index}] (lift '${lift}') has an invalid reps`);
  }
  const date = new Date(e['date'] as string);
  if (isNaN(date.getTime())) {
    throw new Error(`Backup entries[${index}] (lift '${lift}') has an invalid date`);
  }
  const isPR = e['isPR'];
  if (typeof isPR !== 'boolean') {
    throw new Error(`Backup entries[${index}] (lift '${lift}') has an invalid isPR`);
  }
  const source = e['source'];
  if (source !== 'test' && source !== 'program') {
    throw new Error(`Backup entries[${index}] (lift '${lift}') has an invalid source`);
  }
  const goalMet = e['goalMet'];
  if (typeof goalMet !== 'boolean') {
    throw new Error(`Backup entries[${index}] (lift '${lift}') has an invalid goalMet`);
  }
  return { lift, weight, reps, date, isPR, source, goalMet };
}

/**
 * Reads a backup file written by {@link backupExistingHistory} — the
 * envelope shape, not a bare array — and refuses to proceed unless its
 * recorded `program`/`userId` match the current CLI arguments. Without
 * this, `backupFilePath` embeds the program id in the *filename*, but
 * nothing checked that on the way back in: restoring program A's backup
 * into program B would previously succeed silently whenever both belong
 * to the same `--user-id` (the ownership check only proves the caller owns
 * the *target*), overwriting B's history with A's on the one command an
 * operator reaches for precisely because something already went wrong.
 * Every entry is also individually validated ({@link validateBackupEntry})
 * before being handed to the transaction — the seed (CSV) path validates
 * every cell already; a hand-edited or partially-corrupt backup file
 * previously reached the DB with only Prisma's own type errors behind it.
 */
export function readBackupFile(
  restorePath: string,
  program: string,
  userId: string,
): Omit<TrainingMaxHistoryEntry, 'id'>[] {
  const raw = fs.readFileSync(restorePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${restorePath} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error(
      `${restorePath} does not look like a backup file written by this script — expected an ` +
        `object with "program", "userId", and an "entries" array. If this file predates ` +
        `program/user provenance checking (a bare JSON array), it cannot be safely ` +
        `auto-verified — restore it manually, or contact whoever captured it.`,
    );
  }
  const envelope = parsed as BackupEnvelope;
  if (envelope.program !== program) {
    throw new Error(
      `${restorePath} was captured for program '${envelope.program}', not the requested ` +
        `--program '${program}' — refusing to restore across programs.`,
    );
  }
  if (envelope.userId !== userId) {
    throw new Error(
      `${restorePath} was captured for --user-id '${envelope.userId}', not the requested ` +
        `--user-id '${userId}' — refusing to restore across users.`,
    );
  }
  return envelope.entries.map((entry, i) => validateBackupEntry(entry, i));
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

function forceRequiredMessage(
  mode: SeedArgs['mode'],
  program: string,
  existingCount: number,
): string {
  if (mode === 'seed') {
    return (
      `Program '${program}' already has ${existingCount} history row(s). ` +
      `This is unexpected at the normal Phase 2B timing — double-check --program ` +
      `is the intended program before proceeding. Pass --force to confirm and ` +
      `continue (this will delete those ${existingCount} row(s); a backup is ` +
      `written first either way).`
    );
  }
  const verb = mode === 'rollback' ? '--rollback' : '--restore';
  const consequence =
    mode === 'rollback' ? 'exiting without re-seeding' : 're-appending the backup contents';
  return (
    `${verb} will delete ${existingCount} existing history row(s) for program '${program}' ` +
    `before ${consequence}. Pass --force to confirm (a backup of the current state is ` +
    `written first either way).`
  );
}

/**
 * Runs the seed, rollback, or restore. Re-run semantics match the runbook
 * exactly: normal mode is delete-all-then-append (never plain append —
 * `training_max_history` has no unique constraint), gated by `--force`
 * whenever pre-existing history is found (unexpected at the normal Phase 2B
 * timing for `seed`; the expected, normal case for `rollback`/`restore` —
 * see {@link forceRequiredMessage}). `--dry-run` never enforces the
 * `--force` gate itself — it always succeeds and reports whether `--force`
 * would be needed, and also runs the *same* row mapping/validation the
 * real run would, plus a writability probe of the backup directory when
 * there's existing history to back up (the one filesystem dependency the
 * real run's recovery story rests on, and the one thing a rehearsal would
 * otherwise never exercise).
 *
 * The delete and append (or the rollback delete, or the restore's
 * delete-then-append) run inside one `runInteractive` call (from
 * `prisma-tx.util.ts`) with `IMPORT_BATCH_TX_OPTIONS` — previously two
 * independent statements with no transaction at all, so a failure between
 * them left the program's history fully deleted with no automatic
 * recovery; then a bare `prisma.$transaction()` with Prisma's 5s default
 * timeout, which this codebase already found too tight for a large batch
 * write over a normal connection (`IMPORT_TX_TIMEOUT_MS`, #532) — and this
 * script's break-glass connection (a manually-proxied Cloud SQL connection
 * from an operator's machine) has strictly higher latency than that
 * already-too-tight path. `runInteractive` is also this codebase's
 * sanctioned wrapper for exactly this call shape (see
 * `tools/eslint-rules/no-direct-prisma-transaction.js`); the `tx as
 * PrismaClient` cast inside its callback narrows `PrismaExecutor` (`tx`'s
 * declared type) to the concrete type `PrismaTrainingMaxHistoryRepository`
 * requires — the same pattern `PrismaExecutor`'s own doc comment describes.
 */
export async function runSeed(prisma: PrismaClient, args: SeedArgs): Promise<SeedResult> {
  await verifyProgramOwnership(prisma, args.program, args.userId);
  const backupDir = args.backupDir ?? DEFAULT_BACKUP_DIR;
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
    const willSeedRows = filterWillSeedRows(
      parseTMHistoryCsv(fs.readFileSync(args.input, 'utf8')),
    );
    assertSingleProgram(willSeedRows);
    entries = willSeedRows.map((row, i) => {
      try {
        return mapRowToEntry(row);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Row ${i + 1} of Will Seed=true rows (Lift='${row['Lift'] ?? ''}', ` +
            `Cycle Date='${row['Cycle Date'] ?? ''}'): ${msg}`,
        );
      }
    });
    assertNoDuplicateSeedKeys(entries);
  } else if (args.mode === 'restore') {
    entries = readBackupFile(args.restorePath, args.program, args.userId);
  }

  if (args.mode !== 'rollback' && entries.length === 0) {
    throw new Error(
      `The ${args.mode === 'seed' ? 'export' : 'backup file'} produced zero rows to seed ` +
        `(Will Seed=true). A zero-row seed is never a legitimate outcome for this script — ` +
        (args.mode === 'seed'
          ? 'check --input is the correct, current export, and that the source Sheet ' +
            'actually has data to derive from.'
          : 'check --restore points at the correct, non-empty backup file.'),
    );
  }

  if (args.dryRun) {
    if (existingCount > 0) {
      try {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        fs.accessSync(backupDir, fs.constants.W_OK);
      } catch (e) {
        throw new Error(
          `--dry-run: backup directory '${backupDir}' is not writable ` +
            `(${e instanceof Error ? e.message : String(e)}) — the real run would fail here, ` +
            `after already validating your input. Fix --backup-dir or its permissions first.`,
        );
      }
    }
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
    throw new Error(forceRequiredMessage(args.mode, args.program, existingCount));
  }

  let backupPath: string | null = null;
  if (existingCount > 0) {
    const backup = await backupExistingHistory(existing, args.program, args.userId, backupDir);
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

  const writtenCount = await runInteractive(
    prisma,
    async (tx) => {
      const txRepo = new PrismaTrainingMaxHistoryRepository(
        tx as PrismaClient,
        args.userId,
      );
      await txRepo.deleteAllHistory(args.program);
      if (args.mode !== 'rollback') {
        await txRepo.appendHistoryEntries(args.program, entries);
      }
      return args.mode === 'rollback' ? 0 : entries.length;
    },
    IMPORT_BATCH_TX_OPTIONS,
  );

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
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(argv);
  console.log(
    `Mode: ${args.mode === 'seed' ? (args.dryRun ? 'DRY RUN (no writes)' : 'REAL WRITE') : args.mode.toUpperCase()}` +
      (args.dryRun && args.mode !== 'seed' ? ' (DRY RUN — no writes)' : ''),
  );
  // Fail fast on a bad operator-supplied path before any DB round trip.
  if (args.mode === 'seed' && !fs.existsSync(args.input)) {
    throw new Error(
      `--input path does not exist: ${path.resolve(args.input)}. Re-export from the ` +
        `Sheet (Logbook Tools → Export TM History (preview)) and download it as CSV.`,
    );
  }
  if (args.mode === 'restore' && !fs.existsSync(args.restorePath)) {
    throw new Error(`--restore path does not exist: ${path.resolve(args.restorePath)}.`);
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
