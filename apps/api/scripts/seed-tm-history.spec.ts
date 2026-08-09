import {
  ArgParseError,
  backupFilePath,
  filterWillSeedRows,
  formatResult,
  mapRowToEntry,
  parseArgs,
  parseTMHistoryCsv,
  resolveLiftId,
  SeedResult,
} from './seed-tm-history';

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
      program: 'prog-uuid',
      userId: 'user-1',
      input: '/tmp/export.csv',
      dryRun: false,
      force: false,
      rollback: false,
    });
  });

  it('parses --dry-run and --force as flags', () => {
    const args = parseArgs([
      '--program',
      'p',
      '--user-id',
      'u',
      '--input',
      'f.csv',
      '--dry-run',
      '--force',
    ]);
    expect(args.dryRun).toBe(true);
    expect(args.force).toBe(true);
  });

  it('parses a --rollback argument set with no --input', () => {
    const args = parseArgs(['--program', 'p', '--user-id', 'u', '--rollback']);
    expect(args).toEqual({
      program: 'p',
      userId: 'u',
      input: null,
      dryRun: false,
      force: false,
      rollback: true,
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
    expect(args.rollback).toBe(true);
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

  it('throws when neither --input nor --rollback is given', () => {
    expect(() => parseArgs(['--program', 'p', '--user-id', 'u'])).toThrow(
      /--input.*required unless --rollback/,
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
    ).toThrow(/--input is not used with --rollback/);
  });

  it('throws when a flag expecting a value is given none', () => {
    expect(() => parseArgs(['--program'])).toThrow('--program requires a value');
  });

  it('throws when a flag expecting a value is immediately followed by another flag', () => {
    expect(() =>
      parseArgs(['--program', '--user-id', 'u']),
    ).toThrow('--program requires a value');
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
});

describe('filterWillSeedRows', () => {
  it('keeps only rows where Will Seed is exactly "true"', () => {
    const rows = parseTMHistoryCsv(
      csvOf([
        validRow({ 'Cycle #': '1', 'Will Seed': 'true' }),
        validRow({ 'Cycle #': '2', 'Will Seed': 'false' }),
        validRow({ 'Cycle #': '3', 'Will Seed': 'true' }),
      ]),
    );
    const willSeed = filterWillSeedRows(rows);
    expect(willSeed.map((r) => r['Cycle #'])).toEqual(['1', '3']);
  });
});

describe('mapRowToEntry', () => {
  it('maps a valid row to the appendHistoryEntries shape', () => {
    const entry = mapRowToEntry(validRow());
    expect(entry).toEqual({
      lift: 'back-squat',
      weight: 305,
      reps: 1,
      date: new Date('2026-03-01'),
      isPR: true,
      source: 'program',
      goalMet: true,
    });
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

  it('throws on a non-numeric TM', () => {
    expect(() => mapRowToEntry(validRow({ TM: 'not-a-number' }))).toThrow(
      /non-numeric TM/,
    );
  });

  it('throws on an invalid Cycle Date', () => {
    expect(() =>
      mapRowToEntry(validRow({ 'Cycle Date': 'not-a-date' })),
    ).toThrow(/invalid Cycle Date/);
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

  it('mentions the backup path when one was written', () => {
    const out = formatResult({ ...base, backupPath: '/tmp/backup.json' });
    expect(out).toContain('/tmp/backup.json');
  });
});
