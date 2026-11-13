import { LiftRecordExportRow, parseCsvText } from '@lifting-logbook/core';
import { strFromU8, unzipSync } from 'fflate';
import { UserDataRows } from '../ports/IUserDataExportRepository';
import { buildExportFiles, exportFileName, rowCounts, zipExportFiles } from './build-data-export';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const DAY = new Date('2026-01-05T00:00:00.000Z');

const emptyRows = (): UserDataRows => ({
  liftRecords: [],
  trainingMaxes: [],
  strengthGoals: [],
  customPrograms: [],
  customLifts: [],
  userSettings: null,
  macrocycles: [],
  macrocycleDashboards: [],
  macrocycleScheduledWorkouts: [],
  trainingMaxHistory: [],
  bodyWeights: [],
  workoutDateOverrides: [],
  workoutSkipOverrides: [],
  workoutLiftOverrides: [],
  liftMetadata: [],
  liftModifications: [],
  liftModificationMaxes: [],
  missingMaxDismissals: [],
  focusBlocks: [],
  focusDayStates: [],
});

const record = (overrides: Partial<LiftRecordExportRow> = {}): LiftRecordExportRow => ({
  program: 'rpt',
  macrocycleNum: 1,
  workoutNum: 1,
  date: DAY,
  lift: 'Bench Press',
  occurrence: 0,
  setNum: 1,
  weight: 180,
  reps: 8,
  notes: '',
  modifications: [],
  ...overrides,
});

const spec = {
  week: 1,
  offset: 0,
  lift: 'Bench Press',
  increment: 2.5,
  order: 1,
  sets: 3,
  reps: 8,
  amrap: false,
  warmUpPct: '.5',
  wtDecrementPct: 0,
  activation: '',
};

describe('buildExportFiles', () => {
  it('writes the five files for an empty account, with no rows and every table present', () => {
    const files = buildExportFiles(emptyRows(), NOW);

    expect(Object.keys(files).sort()).toEqual([
      'lift-records.csv',
      'logbook.json',
      'program-spec.csv',
      'strength-goals.csv',
      'training-maxes.csv',
    ]);
    expect(parseCsvText(files['lift-records.csv']!)).toHaveLength(1);
    expect(parseCsvText(files['training-maxes.csv']!)).toHaveLength(1);
    expect(parseCsvText(files['program-spec.csv']!)).toHaveLength(1);

    const logbook = JSON.parse(files['logbook.json']!);
    expect(logbook).toEqual({
      schemaVersion: 1,
      exportedAt: NOW.toISOString(),
      tables: JSON.parse(JSON.stringify(emptyRows())),
    });
  });

  it('keeps a single-program account to the five files', () => {
    const rows = emptyRows();
    rows.userSettings = { activeProgram: 'rpt' };
    rows.liftRecords = [record()];
    rows.trainingMaxes = [{ program: 'rpt', dateUpdated: DAY, lift: 'Squat', weight: 300 }];
    rows.strengthGoals = [{ program: 'rpt', lift: 'Squat', goalType: 'absolute', target: 400, unit: 'lbs' }];

    const files = buildExportFiles(rows, NOW);

    expect(Object.keys(files)).toHaveLength(5);
    expect(parseCsvText(files['training-maxes.csv']!)[1]).toEqual(['2026-01-05', 'Squat', '300']);
    expect(files['strength-goals.csv']).toContain('Squat');
  });

  it('roots the active program and files every other program under other-programs', () => {
    const rows = emptyRows();
    const customId = '11111111-2222-3333-4444-555555555555';
    rows.userSettings = { activeProgram: 'rpt' };
    rows.trainingMaxes = [
      { program: 'rpt', dateUpdated: DAY, lift: 'Squat', weight: 300 },
      { program: '5-3-1', dateUpdated: DAY, lift: 'Squat', weight: 280 },
    ];
    rows.strengthGoals = [{ program: customId, lift: 'Squat', goalType: 'relative', ratio: 2, unit: 'lbs' }];
    rows.customPrograms = [{ id: customId, name: 'My Plan!', specs: [spec] }];

    const files = buildExportFiles(rows, NOW);

    expect(files['training-maxes.csv']).toContain('300');
    expect(files['training-maxes.csv']).not.toContain('280');
    expect(files['other-programs/5-3-1/training-maxes.csv']).toContain('280');
    expect(files['other-programs/My-Plan-11111111/strength-goals.csv']).toContain('Squat');
    expect(files['other-programs/My-Plan-11111111/program-spec.csv']).toContain('Bench Press');
    expect(files['other-programs/5-3-1/program-spec.csv']).toBeUndefined();
    expect(parseCsvText(files['program-spec.csv']!)).toHaveLength(1);
  });

  it('writes the root program spec when the active program is custom', () => {
    const rows = emptyRows();
    const customId = '11111111-2222-3333-4444-555555555555';
    rows.userSettings = { activeProgram: customId };
    rows.customPrograms = [{ id: customId, name: 'My Plan', specs: [spec] }];

    const files = buildExportFiles(rows, NOW);

    expect(files['program-spec.csv']).toContain('Bench Press');
    expect(Object.keys(files).filter((path) => path.startsWith('other-programs'))).toEqual([]);
  });

  it('keeps every folder inside the archive, and apart, whatever a program is called', () => {
    const rows = emptyRows();
    rows.userSettings = { activeProgram: 'rpt' };
    rows.trainingMaxes = ['../../evil', '..\\..\\evil', '...', 'C:/evil'].map((program, i) => ({
      program,
      dateUpdated: DAY,
      lift: 'Squat',
      weight: i,
    }));

    const paths = Object.keys(buildExportFiles(rows, NOW)).filter((path) => path.startsWith('other-programs'));

    expect(paths).toHaveLength(4);
    expect(new Set(paths).size).toBe(4);
    for (const path of paths) {
      expect(path).toMatch(/^other-programs\/[A-Za-z0-9_-]+\/training-maxes\.csv$/);
    }
  });

  it('keeps folders apart that differ only by case, and avoids names Windows refuses', () => {
    const rows = emptyRows();
    rows.userSettings = { activeProgram: 'rpt' };
    rows.trainingMaxes = ['PLAN', 'plan', 'nul'].map((program, i) => ({
      program,
      dateUpdated: DAY,
      lift: 'Squat',
      weight: i,
    }));

    const paths = Object.keys(buildExportFiles(rows, NOW)).filter((path) => path.startsWith('other-programs'));

    expect(paths.sort()).toEqual([
      'other-programs/PLAN/training-maxes.csv',
      'other-programs/plan-2/training-maxes.csv',
      'other-programs/program-nul/training-maxes.csv',
    ]);
  });

  describe('with no saved active program', () => {
    const maxesIn = (...programs: string[]) =>
      programs.map((program) => ({ program, dateUpdated: DAY, lift: 'Squat', weight: 100 }));

    it("roots the app's default program when it holds anything", () => {
      const rows = emptyRows();
      rows.trainingMaxes = maxesIn('0-custom', '5-3-1');

      const paths = Object.keys(buildExportFiles(rows, NOW));

      expect(paths).toContain('other-programs/0-custom/training-maxes.csv');
      expect(paths).not.toContain('other-programs/5-3-1/training-maxes.csv');
    });

    it('roots the first program when the default holds nothing, so its data stays at the top', () => {
      const rows = emptyRows();
      rows.trainingMaxes = maxesIn('rpt', 'leangains');

      const files = buildExportFiles(rows, NOW);

      expect(Object.keys(files)).toContain('other-programs/rpt/training-maxes.csv');
      expect(parseCsvText(files['training-maxes.csv']!)).toHaveLength(2);
    });
  });

  it('writes a custom lift by name in every CSV, and leaves a deleted one as its stored id', () => {
    const rows = emptyRows();
    const customId = '11111111-2222-3333-4444-555555555555';
    rows.userSettings = { activeProgram: customId };
    rows.customLifts = [{ id: 'lift-id', name: 'Zercher Squat' }];
    rows.liftRecords = [record({ lift: 'lift-id' }), record({ lift: 'gone-id', setNum: 2 })];
    rows.trainingMaxes = [{ program: customId, dateUpdated: DAY, lift: 'lift-id', weight: 300 }];
    rows.strengthGoals = [{ program: customId, lift: 'lift-id', goalType: 'absolute', target: 400, unit: 'lbs' }];
    rows.customPrograms = [{ id: customId, name: 'My Plan', specs: [{ ...spec, lift: 'lift-id' }] }];

    const files = buildExportFiles(rows, NOW);
    const table = parseCsvText(files['lift-records.csv']!);
    const lift = table[0]!.indexOf('Lift');

    expect(table.slice(1).map((row) => row[lift])).toEqual(['Zercher Squat', 'gone-id']);
    for (const file of ['training-maxes.csv', 'strength-goals.csv', 'program-spec.csv']) {
      expect(files[file]).toContain('Zercher Squat');
      expect(files[file]).not.toContain('lift-id');
    }
  });

  it('splits lift records over the import limit into numbered parts, losing nothing', () => {
    const rows = emptyRows();
    rows.liftRecords = Array.from({ length: 5_001 }, (_, i) => record({ setNum: i + 1 }));

    const files = buildExportFiles(rows, NOW);

    expect(files['lift-records.csv']).toBeUndefined();
    const lengths = [1, 2].map((n) => parseCsvText(files[`lift-records-part-${n}.csv`]!).length - 1);
    expect(lengths).toEqual([5_000, 1]);
  });

  it('keeps exactly the import limit in one file', () => {
    const rows = emptyRows();
    rows.liftRecords = Array.from({ length: 5_000 }, (_, i) => record({ setNum: i + 1 }));

    const files = buildExportFiles(rows, NOW);

    expect(parseCsvText(files['lift-records.csv']!)).toHaveLength(5_001);
  });
});

describe('rowCounts', () => {
  it('counts rows per table, and never holds row contents', () => {
    const rows = emptyRows();
    rows.liftRecords = [record({ notes: 'private note' })];
    rows.userSettings = { activeProgram: 'rpt' };
    rows.customPrograms = [{ id: 'p', name: 'Private plan', specs: [spec, spec] }];

    const counts = rowCounts(rows);

    expect(counts).toMatchObject({ liftRecords: 1, userSettings: 1, customPrograms: 1, customProgramSpecs: 2, focusBlocks: 0 });
    expect(JSON.stringify(counts)).not.toMatch(/private/i);
  });
});

describe('zipExportFiles', () => {
  it('produces an archive that reads back, a large file included', async () => {
    const large = 'row,'.repeat(200_000);

    const archive = await zipExportFiles({ 'a.csv': 'a,b', 'folder/large.csv': large });

    const entries = unzipSync(archive);
    expect(strFromU8(entries['a.csv']!)).toBe('a,b');
    expect(strFromU8(entries['folder/large.csv']!)).toBe(large);
  });
});

describe('exportFileName', () => {
  it('dates the archive', () => {
    expect(exportFileName(NOW)).toBe('lifting-logbook-export-2026-11-06.zip');
  });
});
