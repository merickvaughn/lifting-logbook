import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrainingMaxHistoryEntry } from '@lifting-logbook/core';
import {
  ArgParseError,
  assertNoDuplicateSeedKeys,
  assertSingleProgram,
  backupExistingHistory,
  backupFilePath,
  filterWillSeedRows,
  formatResult,
  mapRowToEntry,
  parseArgs,
  parseTMHistoryCsv,
  readBackupFile,
  REQUIRED_COLUMNS,
  resolveLiftId,
  SeedResult,
} from './seed-tm-history';

function historyEntry(overrides: Partial<TrainingMaxHistoryEntry> = {}): TrainingMaxHistoryEntry {
  return {
    id: 'entry-1',
    lift: 'back-squat',
    weight: 300,
    reps: 1,
    date: new Date('2026-01-01T00:00:00.000Z'),
    isPR: true,
    source: 'program',
    goalMet: true,
    ...overrides,
  };
}

/** Mirrors seed-tm-history.db.e2e.spec.ts's helper of the same name/shape —
 * see that file's doc comment for the full rationale ("an assertion already
 * proved this is non-null, now tell the compiler," without the confusing
 * failure mode a bare `!` or `as` produces the first time it's actually
 * wrong). Not shared/imported from there: each spec file's test helpers
 * stay local and self-contained, matching this repo's existing convention. */
function assertNotNull<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`expected ${what} to be non-null`);
  return value;
}

describe('parseArgs', () => {
  it('parses a full normal-seed argument set', () => {
    const args = parseArgs([
      '--program',
      'prog-uuid',
      '--user-id',
      'user-1',
      '--input',
      '/tmp/export.csv',
    ]);
    expect(args).toEqual({
      mode: 'seed',
      program: 'prog-uuid',
      userId: 'user-1',
      input: '/tmp/export.csv',
      dryRun: false,
      force: false,
      backupDir: null,
    });
  });

  it('parses --dry-run, --force, and --backup-dir', () => {
    const args = parseArgs([
      '--program',
      'p',
      '--user-id',
      'u',
      '--input',
      'f.csv',
      '--dry-run',
      '--force',
      '--backup-dir',
      '/tmp/backups',
    ]);
    expect(args.dryRun).toBe(true);
    expect(args.force).toBe(true);
    expect(args.backupDir).toBe('/tmp/backups');
  });

  it('accepts --flag=value syntax', () => {
    const args = parseArgs(['--program=p', '--user-id=u', '--input=f.csv']);
    expect(args).toMatchObject({ program: 'p', userId: 'u', input: 'f.csv' });
  });

  it('parses a --rollback argument set with mode "rollback"', () => {
    const args = parseArgs(['--program', 'p', '--user-id', 'u', '--rollback']);
    expect(args).toEqual({
      mode: 'rollback',
      program: 'p',
      userId: 'u',
      dryRun: false,
      force: false,
      backupDir: null,
    });
  });

  it('parses a --restore argument set with mode "restore"', () => {
    const args = parseArgs([
      '--program',
      'p',
      '--user-id',
      'u',
      '--restore',
      '/tmp/backup.json',
    ]);
    expect(args).toEqual({
      mode: 'restore',
      program: 'p',
      userId: 'u',
      restorePath: '/tmp/backup.json',
      dryRun: false,
      force: false,
      backupDir: null,
    });
  });

  it('allows --rollback combined with --dry-run', () => {
    const args = parseArgs([
      '--program',
      'p',
      '--user-id',
      'u',
      '--rollback',
      '--dry-run',
    ]);
    expect(args.mode).toBe('rollback');
    expect(args.dryRun).toBe(true);
  });

  it('throws when --program is missing', () => {
    expect(() =>
      parseArgs(['--user-id', 'u', '--input', 'f.csv']),
    ).toThrow(ArgParseError);
  });

  it('throws when --user-id is missing', () => {
    expect(() => parseArgs(['--program', 'p', '--input', 'f.csv'])).toThrow(
      ArgParseError,
    );
  });

  it('throws when none of --input/--rollback/--restore is given', () => {
    expect(() => parseArgs(['--program', 'p', '--user-id', 'u'])).toThrow(
      /exactly one of --input/,
    );
  });

  it('throws when --input is combined with --rollback', () => {
    expect(() =>
      parseArgs([
        '--program',
        'p',
        '--user-id',
        'u',
        '--rollback',
        '--input',
        'f.csv',
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it('throws when --input is combined with --restore', () => {
    expect(() =>
      parseArgs([
        '--program',
        'p',
        '--user-id',
        'u',
        '--input',
        'f.csv',
        '--restore',
        'b.json',
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it('throws when a flag expecting a value is given none', () => {
    expect(() => parseArgs(['--program'])).toThrow('--program requires a value');
  });

  it('throws when a flag expecting a value is immediately followed by another flag', () => {
    expect(() =>
      parseArgs(['--program', '--user-id', 'u']),
    ).toThrow('--program requires a value');
  });

  it('throws on an unrecognized flag rather than silently ignoring it', () => {
    // The exact scenario a typo'd --dry-run used to hit: silently parsed as
    // "flag not set" instead of erroring, turning a preview request into a
    // real write.
    expect(() =>
      parseArgs(['--program', 'p', '--user-id', 'u', '--input', 'f.csv', '--dryrun']),
    ).toThrow(/Unrecognized flag '--dryrun'/);
  });

  it('throws on a bare non-flag token', () => {
    expect(() => parseArgs(['p'])).toThrow(/Unrecognized argument 'p'/);
  });

  it('throws when a value-flag is passed more than once', () => {
    expect(() =>
      parseArgs(['--program', 'a', '--program', 'b', '--user-id', 'u', '--rollback']),
    ).toThrow(/--program was passed more than once/);
  });

  it('throws when a boolean flag is given a value via = syntax', () => {
    expect(() =>
      parseArgs(['--program', 'p', '--user-id', 'u', '--rollback=true']),
    ).toThrow(/--rollback does not take a value/);
  });
});

describe('resolveLiftId', () => {
  it('resolves a known human-readable lift name to its canonical id', () => {
    expect(resolveLiftId('Squat')).toBe('back-squat');
  });

  it('passes through an unresolved lift name verbatim', () => {
    expect(resolveLiftId("Farmer's Carry")).toBe("Farmer's Carry");
  });
});

const HEADERS = [
  'Program',
  'Lift',
  'Cycle #',
  'Cycle Date',
  'TM',
  'Set 1 Reps',
  'Spec Reps',
  'Increment',
  'Transition',
  'Goal Met',
  'Is PR',
  'Will Seed',
  'TM Source',
  'Bodyweight',
  'Added Weight',
];

function csvOf(rows: Record<string, string>[]): string {
  const lines = [HEADERS.join(',')];
  for (const row of rows) {
    lines.push(HEADERS.map((h) => row[h] ?? '').join(','));
  }
  return lines.join('\n');
}

function validRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Program: 'RPT',
    Lift: 'Squat',
    'Cycle #': '4',
    'Cycle Date': '2026-03-01',
    TM: '305',
    'Set 1 Reps': '5',
    'Spec Reps': '5',
    Increment: '5',
    Transition: 'bump',
    'Goal Met': 'true',
    'Is PR': 'true',
    'Will Seed': 'true',
    'TM Source': 'workout-sheet',
    Bodyweight: '',
    'Added Weight': '',
    ...overrides,
  };
}

describe('REQUIRED_COLUMNS', () => {
  it('is a superset the fixture headers above actually satisfy', () => {
    for (const col of REQUIRED_COLUMNS) {
      expect(HEADERS).toContain(col);
    }
  });
});

describe('parseTMHistoryCsv', () => {
  it('parses a well-formed export into row objects', () => {
    const rows = parseTMHistoryCsv(csvOf([validRow()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Program: 'RPT', Lift: 'Squat', TM: '305' });
  });

  it('returns an empty array for a header-only CSV', () => {
    expect(parseTMHistoryCsv(HEADERS.join(','))).toEqual([]);
  });

  it('throws an actionable error when expected columns are missing (stale export)', () => {
    const staleHeaders = HEADERS.filter((h) => h !== 'Will Seed');
    const content = [staleHeaders.join(','), staleHeaders.map(() => 'x').join(',')].join(
      '\n',
    );
    expect(() => parseTMHistoryCsv(content)).toThrow(/missing expected column/);
    expect(() => parseTMHistoryCsv(content)).toThrow(/Will Seed/);
  });

  it('throws when expected columns are missing even on a header-only (zero data row) CSV', () => {
    // Previously the column check only ran when rows.length > 0, so a
    // header-only OR fully-empty file skipped validation entirely.
    const staleHeaders = HEADERS.filter((h) => h !== 'Will Seed');
    expect(() => parseTMHistoryCsv(staleHeaders.join(','))).toThrow(
      /missing expected column/,
    );
  });

  it('strips a leading UTF-8 BOM from the header rather than treating the first column as missing', () => {
    // The natural way a human eyeballs this file (per the runbook's Step 3)
    // is opening it in a spreadsheet tool, which reliably re-saves with a
    // BOM — csv-parse leaves it attached to the first header cell unless
    // told to strip it, turning "Program" into "﻿Program".
    const content = '﻿' + csvOf([validRow()]);
    const rows = parseTMHistoryCsv(content);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Program: 'RPT' });
  });

  it('trims stray whitespace from header names before comparing against REQUIRED_COLUMNS', () => {
    const headersWithSpace = HEADERS.map((h) => (h === 'Program' ? ' Program ' : h));
    const content = [
      headersWithSpace.join(','),
      headersWithSpace.map((h) => validRow()[h.trim()] ?? '').join(','),
    ].join('\n');
    const rows = parseTMHistoryCsv(content);
    expect(rows[0]).toMatchObject({ Program: 'RPT' });
  });
});

describe('filterWillSeedRows', () => {
  it('keeps only rows where Will Seed is exactly "true" (case-insensitive)', () => {
    const rows = parseTMHistoryCsv(
      csvOf([
        validRow({ 'Cycle #': '1', 'Will Seed': 'true' }),
        validRow({ 'Cycle #': '2', 'Will Seed': 'false' }),
        validRow({ 'Cycle #': '3', 'Will Seed': 'TRUE' }),
      ]),
    );
    const willSeed = filterWillSeedRows(rows);
    expect(willSeed.map((r) => r['Cycle #'])).toEqual(['1', '3']);
  });

  it('throws on an unrecognized Will Seed value rather than silently treating it as false', () => {
    // This is the guard against a whole-file format mismatch (e.g. Google
    // Sheets rendering booleans differently on CSV export) silently
    // producing an empty seed set, which downstream feeds a full wipe.
    const rows = parseTMHistoryCsv(csvOf([validRow({ 'Will Seed': 'yes' })]));
    expect(() => filterWillSeedRows(rows)).toThrow(/not a recognized boolean/);
  });

  it('throws on a blank Will Seed value (never legitimately empty)', () => {
    const rows = parseTMHistoryCsv(csvOf([validRow({ 'Will Seed': '' })]));
    expect(() => filterWillSeedRows(rows)).toThrow(/not a recognized boolean/);
  });
});

describe('assertSingleProgram', () => {
  it('does not throw when every row shares the same Program value', () => {
    const rows = parseTMHistoryCsv(
      csvOf([validRow({ Program: 'RPT' }), validRow({ Program: 'RPT', 'Cycle #': '5' })]),
    );
    expect(() => assertSingleProgram(rows)).not.toThrow();
  });

  it('does not throw on an empty row set', () => {
    expect(() => assertSingleProgram([])).not.toThrow();
  });

  it('throws when rows span more than one distinct Program value', () => {
    const rows = parseTMHistoryCsv(
      csvOf([validRow({ Program: 'RPT' }), validRow({ Program: 'nSuns', 'Cycle #': '5' })]),
    );
    expect(() => assertSingleProgram(rows)).toThrow(/2 different Program values/);
    expect(() => assertSingleProgram(rows)).toThrow(/RPT/);
    expect(() => assertSingleProgram(rows)).toThrow(/nSuns/);
  });

  it('ignores blank Program values rather than counting them as a distinct program', () => {
    const rows = parseTMHistoryCsv(
      csvOf([validRow({ Program: 'RPT' }), validRow({ Program: '', 'Cycle #': '5' })]),
    );
    expect(() => assertSingleProgram(rows)).not.toThrow();
  });
});

describe('assertNoDuplicateSeedKeys', () => {
  it('does not throw when every (lift, date) pair is unique', () => {
    const entries = [validRow(), validRow({ Lift: 'Bench Press', 'Cycle #': '5' })].map(
      mapRowToEntry,
    );
    expect(() => assertNoDuplicateSeedKeys(entries)).not.toThrow();
  });

  it('throws when the same resolved lift and cycle date appear twice', () => {
    const entries = [
      validRow({ Lift: 'Squat' }),
      validRow({ Lift: 'Squat', 'Cycle #': '5' }), // same lift + same Cycle Date
    ].map(mapRowToEntry);
    expect(() => assertNoDuplicateSeedKeys(entries)).toThrow(/Duplicate seed key/);
    expect(() => assertNoDuplicateSeedKeys(entries)).toThrow(/back-squat/);
  });

  it('compares resolved lift ids, not raw CSV lift strings', () => {
    // Constructed directly (bypassing mapRowToEntry/resolveLiftId) to
    // deterministically exercise the case two differently-spelled raw CSV
    // names that both resolve to the same target lift would produce: two
    // entries sharing one resolved `lift` id. The check must operate on
    // that resolved id, not on whatever the CSV originally said (which
    // isn't even available at this point in the pipeline).
    const a = mapRowToEntry(validRow({ Lift: 'Squat' }));
    const b = { ...mapRowToEntry(validRow({ Lift: 'Bench Press', 'Cycle #': '5' })), lift: a.lift };
    expect(() => assertNoDuplicateSeedKeys([a, b])).toThrow(/Duplicate seed key/);
  });
});

describe('mapRowToEntry', () => {
  it('maps a valid row to the appendHistoryEntries shape', () => {
    const entry = mapRowToEntry(validRow());
    expect(entry).toEqual({
      lift: 'back-squat',
      weight: 305,
      reps: 1,
      date: new Date(Date.UTC(2026, 2, 1)),
      isPR: true,
      source: 'program',
      goalMet: true,
    });
  });

  it('accepts uppercase TRUE/FALSE for Is PR (case-insensitive)', () => {
    expect(mapRowToEntry(validRow({ 'Is PR': 'TRUE' })).isPR).toBe(true);
    expect(mapRowToEntry(validRow({ 'Is PR': 'FALSE' })).isPR).toBe(false);
  });

  it('always sets reps to 1, regardless of the source row', () => {
    const entry = mapRowToEntry(validRow());
    expect(entry.reps).toBe(1);
  });

  it('always sets source to "program", never derived from TM Source', () => {
    const entry = mapRowToEntry(validRow({ 'TM Source': 'lift-records' }));
    expect(entry.source).toBe('program');
  });

  it('coerces a blank Goal Met to false (the target column is non-null Boolean)', () => {
    const entry = mapRowToEntry(validRow({ 'Goal Met': '' }));
    expect(entry.goalMet).toBe(false);
  });

  it('resolves an unmapped lift name verbatim, matching resolveLiftId', () => {
    const entry = mapRowToEntry(validRow({ Lift: "Farmer's Carry" }));
    expect(entry.lift).toBe("Farmer's Carry");
  });

  it('throws on an empty TM', () => {
    expect(() => mapRowToEntry(validRow({ TM: '' }))).toThrow(/empty TM/);
  });

  it('throws on a whitespace-only TM', () => {
    expect(() => mapRowToEntry(validRow({ TM: '   ' }))).toThrow(/empty TM/);
  });

  it('throws on a non-numeric TM', () => {
    expect(() => mapRowToEntry(validRow({ TM: 'not-a-number' }))).toThrow(
      /invalid TM/,
    );
  });

  it('throws on a zero TM (Number("") === 0 must not silently pass as a real value)', () => {
    expect(() => mapRowToEntry(validRow({ TM: '0' }))).toThrow(/invalid TM/);
  });

  it('throws on a negative TM', () => {
    expect(() => mapRowToEntry(validRow({ TM: '-5' }))).toThrow(/invalid TM/);
  });

  it('throws on a non-finite TM', () => {
    expect(() => mapRowToEntry(validRow({ TM: 'Infinity' }))).toThrow(/invalid TM/);
  });

  it('throws on an invalid Cycle Date', () => {
    expect(() =>
      mapRowToEntry(validRow({ 'Cycle Date': 'not-a-date' })),
    ).toThrow(/not in yyyy-MM-dd format/);
  });

  it('throws on a locale-formatted Cycle Date rather than silently transposing month/day', () => {
    expect(() =>
      mapRowToEntry(validRow({ 'Cycle Date': '03/01/2026' })),
    ).toThrow(/not in yyyy-MM-dd format/);
  });

  it('parses Cycle Date as UTC midnight, not local midnight', () => {
    const entry = mapRowToEntry(validRow({ 'Cycle Date': '2026-03-01' }));
    expect(entry.date.getUTCFullYear()).toBe(2026);
    expect(entry.date.getUTCMonth()).toBe(2); // 0-indexed: March
    expect(entry.date.getUTCDate()).toBe(1);
    expect(entry.date.getUTCHours()).toBe(0);
  });
});

describe('backupFilePath', () => {
  it('builds a deterministic, collision-resistant path from program + timestamp', () => {
    const now = new Date('2026-03-01T12:34:56.789Z');
    const p = backupFilePath('/tmp/backups', 'prog-uuid', now);
    expect(p).toContain('prog-uuid');
    expect(p).toContain('tm-history-backup-');
    expect(p.endsWith('.json')).toBe(true);
    // No raw colons/dots from the ISO timestamp — must be filesystem-safe on Windows.
    expect(p).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('produces different paths for different timestamps on the same program', () => {
    const a = backupFilePath('/tmp', 'p', new Date('2026-03-01T00:00:00.000Z'));
    const b = backupFilePath('/tmp', 'p', new Date('2026-03-01T00:00:01.000Z'));
    expect(a).not.toBe(b);
  });
});

// backupExistingHistory/readBackupFile take already-fetched entries and do
// only fs/JSON work now (no Prisma) — real Postgres coverage of the whole
// backup-then-restore round trip against a live DB still lives in
// seed-tm-history.db.e2e.spec.ts via runSeed; these are the function-level
// tests for the fs/envelope mechanics themselves. Uses real temp
// directories (fs.mkdtempSync) rather than mocking fs, per this repo's
// general "test against the real thing" preference.
describe('backupExistingHistory / readBackupFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-tm-history-unit-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null and writes no file when there is nothing to back up', async () => {
    const result = await backupExistingHistory([], 'prog-1', 'user-1', dir);
    expect(result).toBeNull();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('writes an envelope (not a bare array) and verifies it by reading it back', async () => {
    const entries = [historyEntry({ id: 'a' }), historyEntry({ id: 'b', lift: 'deadlift' })];
    const result = await backupExistingHistory(entries, 'prog-1', 'user-1', dir);
    expect(result).not.toBeNull();
    expect(result?.count).toBe(2);

    const nonNullResult = assertNotNull(result, 'backupExistingHistory result');
    const raw = JSON.parse(fs.readFileSync(nonNullResult.path, 'utf8'));
    expect(raw.program).toBe('prog-1');
    expect(raw.userId).toBe('user-1');
    expect(typeof raw.capturedAt).toBe('string');
    expect(raw.entries).toHaveLength(2);
  });

  it('round-trips through readBackupFile back to appendable entries', async () => {
    const entries = [historyEntry({ id: 'a', weight: 315 })];
    const backup = assertNotNull(
      await backupExistingHistory(entries, 'prog-1', 'user-1', dir),
      'backup',
    );
    const restored = readBackupFile(backup.path, 'prog-1', 'user-1');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ lift: 'back-squat', weight: 315 });
    expect(restored[0]).not.toHaveProperty('id'); // stripped, not carried into the re-append
    expect(restored[0]?.date).toBeInstanceOf(Date);
  });

  it('readBackupFile refuses to restore against a different program', async () => {
    const backup = assertNotNull(
      await backupExistingHistory([historyEntry()], 'prog-1', 'user-1', dir),
      'backup',
    );
    expect(() => readBackupFile(backup.path, 'prog-2', 'user-1')).toThrow(
      /captured for program 'prog-1'.*not the requested --program 'prog-2'/s,
    );
  });

  it('readBackupFile refuses to restore against a different user', async () => {
    const backup = assertNotNull(
      await backupExistingHistory([historyEntry()], 'prog-1', 'user-1', dir),
      'backup',
    );
    expect(() => readBackupFile(backup.path, 'prog-1', 'user-2')).toThrow(
      /captured for --user-id 'user-1'.*not the requested --user-id 'user-2'/s,
    );
  });

  it('readBackupFile rejects a bare-array backup (pre-envelope format)', () => {
    const file = path.join(dir, 'old-format.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'a', lift: 'back-squat' }]));
    expect(() => readBackupFile(file, 'prog-1', 'user-1')).toThrow(
      /does not look like a backup file/,
    );
  });

  it('readBackupFile rejects invalid JSON with a clear message rather than an unhandled parse error', () => {
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, '{not valid json');
    expect(() => readBackupFile(file, 'prog-1', 'user-1')).toThrow(/not valid JSON/);
  });

  it('readBackupFile rejects an entry with an invalid weight rather than passing it through to the DB', async () => {
    const backup = assertNotNull(
      await backupExistingHistory([historyEntry()], 'prog-1', 'user-1', dir),
      'backup',
    );
    const raw = JSON.parse(fs.readFileSync(backup.path, 'utf8'));
    raw.entries[0].weight = 'not-a-number';
    fs.writeFileSync(backup.path, JSON.stringify(raw));
    expect(() => readBackupFile(backup.path, 'prog-1', 'user-1')).toThrow(
      /invalid weight/,
    );
  });

  it('readBackupFile rejects an entry with an invalid date', async () => {
    const backup = assertNotNull(
      await backupExistingHistory([historyEntry()], 'prog-1', 'user-1', dir),
      'backup',
    );
    const raw = JSON.parse(fs.readFileSync(backup.path, 'utf8'));
    raw.entries[0].date = 'not-a-date';
    fs.writeFileSync(backup.path, JSON.stringify(raw));
    expect(() => readBackupFile(backup.path, 'prog-1', 'user-1')).toThrow(/invalid date/);
  });

  // Deliberately not covered here: the symlink-backup-directory refusal
  // (creating a directory symlink in a unit test is unreliable across
  // platforms — Windows requires Developer Mode or elevation for
  // fs.symlinkSync, which cannot be assumed in every environment this
  // suite runs in) and exact permission-mode assertions (Windows has no
  // unix mode bits, so a `mode === 0o600`-style assertion would be
  // meaningless/flaky there even though the underlying fs.writeFileSync
  // `mode` option is real, functioning hardening on Linux/macOS, where the
  // exposure this guards against actually applies). Noted in the PR body
  // as a deliberate coverage deferral rather than an oversight.
});

describe('formatResult', () => {
  const base: SeedResult = {
    mode: 'seeded',
    program: 'prog-uuid',
    existingCount: 0,
    forceRequired: false,
    writtenCount: 12,
    backupPath: null,
  };

  it('reports a normal seed', () => {
    const out = formatResult(base);
    expect(out).toContain('Seeded');
    expect(out).toContain('wrote 12 row(s)');
  });

  it('reports a dry run without claiming anything was written', () => {
    const out = formatResult({ ...base, mode: 'dry-run' });
    expect(out).toContain('DRY RUN');
    expect(out).toContain('nothing was written');
  });

  it('flags that --force would be required when forceRequired is true, on a dry run', () => {
    const out = formatResult({
      ...base,
      mode: 'dry-run',
      existingCount: 5,
      forceRequired: true,
    });
    expect(out).toContain('would require --force');
  });

  it('reports a rollback with zero written', () => {
    const out = formatResult({ ...base, mode: 'rolled-back', existingCount: 5 });
    expect(out).toContain('Rolled back');
    expect(out).toContain('deleted 5 row(s)');
    expect(out).toContain('wrote 0');
  });

  it('reports a restore', () => {
    const out = formatResult({ ...base, mode: 'restored', existingCount: 2, writtenCount: 5 });
    expect(out).toContain('Restored');
    expect(out).toContain('deleted 2 row(s)');
    expect(out).toContain('wrote 5 row(s) from backup');
  });

  it('mentions the backup path when one was written', () => {
    const out = formatResult({ ...base, backupPath: '/tmp/backup.json' });
    expect(out).toContain('/tmp/backup.json');
  });
});
