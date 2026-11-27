import { classifyImport } from '../import/classifyImport';
import {
  parseCsvText,
  parseLiftingProgramSpec,
  parseLiftRecords,
  parseStrengthGoals,
  parseTrainingMaxes,
} from '../parser';
import {
  LiftRecordExportRow,
  LIFT_RECORD_EXPORT_HEADERS,
  escapeCsvFormula,
  serializeLiftRecords,
  serializeProgramSpec,
  serializeStrengthGoals,
  serializeTrainingMaxes,
  liftRecordExportFileName,
  splitLiftRecordsForImport,
  unescapeCsvFormula,
} from './serializeExportCsv';

const date = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

const record = (overrides: Partial<LiftRecordExportRow> = {}): LiftRecordExportRow => ({
  program: 'rpt',
  macrocycleNum: 1,
  workoutNum: 1,
  date: date('2026-01-05'),
  lift: 'Bench Press',
  occurrence: 0,
  setNum: 1,
  weight: 180,
  reps: 8,
  notes: '',
  modifications: [],
  ...overrides,
});

describe('escapeCsvFormula', () => {
  // Text that really starts with apostrophes before a trigger gets one more, so import can tell.
  it.each(['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx', '\nx', "'=x", "''-ish"])('prefixes %j', (text) => {
    expect(escapeCsvFormula(text)).toBe(`'${text}`);
  });

  it.each(['', 'Bench Press', "'tis", "'", 'a=b'])('leaves %j alone', (text) => {
    expect(escapeCsvFormula(text)).toBe(text);
  });
});

describe('unescapeCsvFormula', () => {
  it.each(['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx', '\nx', "'=x", "''-ish", "'tis", "'", ''])(
    'reverses the escape of %j',
    (text) => {
      expect(unescapeCsvFormula(escapeCsvFormula(text))).toBe(text);
    },
  );

  it.each(['', "'", "'tis", "''tis", 'Bench Press'])('leaves %j alone', (text) => {
    expect(unescapeCsvFormula(text)).toBe(text);
  });

  it('drops one apostrophe of several before a trigger', () => {
    expect(unescapeCsvFormula("''=x")).toBe("'=x");
  });
});

describe('serializeLiftRecords', () => {
  it('writes the decision 22 columns, and reads back through parseLiftRecords', () => {
    const table = parseCsvText(serializeLiftRecords([record({ notes: 'paused, "slow"' })]));
    expect(table[0]).toEqual(LIFT_RECORD_EXPORT_HEADERS);
    expect(table[0]).toEqual(
      expect.arrayContaining(['Program', 'Macrocycle #', 'Workout #', 'Occurrence', 'Modifications', 'Status']),
    );
    expect(parseLiftRecords(table)).toEqual([
      expect.objectContaining({
        program: 'rpt',
        macrocycleNum: 1,
        workoutNum: 1,
        date: date('2026-01-05'),
        lift: 'Bench Press',
        setNum: 1,
        weight: 180,
        reps: 8,
        notes: 'paused, "slow"',
      }),
    ]);
  });

  it('writes occurrence, modification ids and the status, empty when there is none', () => {
    const [, row, unset] = parseCsvText(
      serializeLiftRecords([
        record({ occurrence: 1, modifications: ['id-a', 'id-b'], status: 'overran' }),
        record({ setNum: 2, status: null }),
      ]),
    );
    const cell = (r: readonly unknown[] | undefined, header: string) => r?.[LIFT_RECORD_EXPORT_HEADERS.indexOf(header)];
    expect(cell(row, 'Occurrence')).toBe('1');
    expect(cell(row, 'Modifications')).toBe('id-a;id-b');
    expect(cell(row, 'Status')).toBe('overran');
    expect(cell(unset, 'Status')).toBe('');
  });

  it('reads its status, occurrence and modification ids back through an assign parse (#1308)', () => {
    const table = parseCsvText(
      serializeLiftRecords([record({ occurrence: 1, modifications: ['id-a', 'id-b'], status: 'overran' })]),
    );
    expect(parseLiftRecords(table, { assign: true })).toEqual([
      expect.objectContaining({ occurrence: 1, modifications: ['id-a', 'id-b'], status: 'overran' }),
    ]);
    // A file that isn't an assign import doesn't read the export's own columns.
    expect(parseLiftRecords(table)[0]).not.toHaveProperty('modifications');
  });

  it('writes a complex and its round, and reads them back in either parse (#1494)', () => {
    const table = parseCsvText(
      serializeLiftRecords([record({ complex: 'Complex 1A', complexRound: 2 }), record({ setNum: 2 })]),
    );
    const [, tagged, plain] = table;
    const cell = (r: readonly unknown[] | undefined, header: string) => r?.[LIFT_RECORD_EXPORT_HEADERS.indexOf(header)];
    expect(cell(tagged, 'Complex')).toBe('Complex 1A');
    expect(cell(tagged, 'Round')).toBe('2');
    expect(cell(plain, 'Complex')).toBe('');
    expect(cell(plain, 'Round')).toBe('');
    for (const assign of [true, false]) {
      const [first, second] = parseLiftRecords(table, { assign });
      expect(first).toMatchObject({ complex: 'Complex 1A', complexRound: 2 });
      expect(second).not.toHaveProperty('complex');
      expect(second).not.toHaveProperty('complexRound');
    }
  });

  it('escapes a complex name the way it escapes a lift', () => {
    const table = parseCsvText(serializeLiftRecords([record({ complex: '=HYPERLINK(1)', complexRound: 1 })]));
    expect(table[1]?.[LIFT_RECORD_EXPORT_HEADERS.indexOf('Complex')]).toBe("'=HYPERLINK(1)");
    expect(parseLiftRecords(table)[0]).toMatchObject({ complex: '=HYPERLINK(1)' });
  });

  // Decision 22: what the export escapes, the importer reads back as written.
  it.each(['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx', '\nx'])(
    'reads a lift and note starting with %j back without the apostrophe',
    (text) => {
      const table = parseCsvText(serializeLiftRecords([record({ program: text, lift: text, notes: text })]));
      const [, row] = table;
      expect(row?.[LIFT_RECORD_EXPORT_HEADERS.indexOf('Lift')]).toBe(`'${text}`);
      for (const assign of [true, false]) {
        expect(parseLiftRecords(table, { assign })[0]).toMatchObject({ program: text, lift: text, notes: text });
      }
    },
  );

  it("keeps a note that really starts with an apostrophe, and a negative weight, as written", () => {
    const table = parseCsvText(serializeLiftRecords([record({ notes: "'tis heavy", weight: -10 })]));
    expect(parseLiftRecords(table, { assign: true })[0]).toMatchObject({ notes: "'tis heavy", weight: -10 });
  });

  it("leaves an apostrophe alone in a file that isn't an export", () => {
    const table = parseCsvText(
      'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes\nrpt,1,1,2026-01-05,Bench Press,1,100,5,\'=x',
    );
    expect(parseLiftRecords(table)[0]).toMatchObject({ notes: "'=x" });
  });

  it('escapes program, lift and notes, but never a negative weight', () => {
    const [, row] = parseCsvText(
      serializeLiftRecords([record({ program: '=p', lift: '+lift', notes: '@note', weight: -10 })]),
    );
    const cell = (header: string) => row![LIFT_RECORD_EXPORT_HEADERS.indexOf(header)];
    expect(cell('Program')).toBe("'=p");
    expect(cell('Lift')).toBe("'+lift");
    expect(cell('Notes')).toBe("'@note");
    expect(cell('Weight')).toBe('-10');
  });

  it('is classified as lift records', () => {
    const table = parseCsvText(serializeLiftRecords([record()]));
    expect(classifyImport(table).type).toBe('lift-records');
  });

  it('is classified as lift records when no lift name is recognized', () => {
    const table = parseCsvText(serializeLiftRecords([record({ lift: 'Zercher Squat' })]));
    expect(classifyImport(table).type).toBe('lift-records');
  });
});

describe('liftRecordExportFileName', () => {
  it('dates the file, and names the part only when there is more than one', () => {
    expect(liftRecordExportFileName('2026-11-15', 1, 1)).toBe('lift-records-2026-11-15.csv');
    expect(liftRecordExportFileName('2026-11-15', 2, 3)).toBe('lift-records-2026-11-15-part-2-of-3.csv');
  });
});

describe('splitLiftRecordsForImport', () => {
  const macrocycle = (program: string, macrocycleNum: number, start: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      record({ program, macrocycleNum, date: date(start), setNum: i + 1 }),
    );

  it('returns no parts for no records', () => {
    expect(splitLiftRecordsForImport([], 10)).toEqual([]);
  });

  it('keeps everything in one part when it fits, exactly at the limit included', () => {
    const rows = macrocycle('rpt', 1, '2026-01-05', 10);
    expect(splitLiftRecordsForImport(rows, 10)).toEqual([rows]);
  });

  it('cuts between macrocycles, oldest first, whatever order rows arrive in', () => {
    const newest = macrocycle('rpt', 3, '2026-03-02', 6);
    const middle = macrocycle('5-3-1', 1, '2026-02-02', 6);
    const oldest = macrocycle('rpt', 1, '2026-01-05', 3);
    const parts = splitLiftRecordsForImport([...newest, ...middle, ...oldest], 10);

    expect(parts).toEqual([[...oldest, ...middle], newest]);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(10);
  });

  it('keeps the same number in two programs apart', () => {
    const parts = splitLiftRecordsForImport(
      [...macrocycle('rpt', 1, '2026-01-05', 6), ...macrocycle('5-3-1', 1, '2026-01-05', 6)],
      10,
    );
    expect(parts.map((part) => [...new Set(part.map((r) => r.program))])).toEqual([['5-3-1'], ['rpt']]);
  });

  it('cuts a macrocycle over the limit without losing a row', () => {
    const big = macrocycle('rpt', 1, '2026-01-05', 25);
    const next = macrocycle('rpt', 2, '2026-02-02', 2);
    const parts = splitLiftRecordsForImport([...next, ...big], 10);

    expect(parts.map((part) => part.length)).toEqual([10, 10, 7]);
    expect(parts.flat()).toEqual([...big, ...next]);
  });

  it('cuts non-cycle rows between workouts, since they have no macrocycle boundaries', () => {
    const workout = (workoutNum: number, start: string) =>
      macrocycle('non-cycle', 1, start, 4).map((r) => ({ ...r, workoutNum }));
    const first = workout(1, '2026-01-05');
    const second = workout(2, '2026-01-06');
    const third = workout(3, '2026-01-07');

    expect(splitLiftRecordsForImport([...third, ...first, ...second], 10)).toEqual([
      [...first, ...second],
      third,
    ]);
  });

  it('orders a macrocycle by date and workout, keeping input order within a workout', () => {
    const second = record({ workoutNum: 2, date: date('2026-01-07') });
    const firstA = record({ lift: 'Squat' });
    const firstB = record({ lift: 'Bench Press' });
    expect(splitLiftRecordsForImport([second, firstA, firstB], 10)).toEqual([[firstA, firstB, second]]);
  });
});

describe('serializeTrainingMaxes', () => {
  it('reads back through parseTrainingMaxes and is classified', () => {
    const maxes = [{ dateUpdated: date('2026-01-05'), lift: 'Bench Press', weight: 182.5 }];
    const table = parseCsvText(serializeTrainingMaxes(maxes));
    expect(parseTrainingMaxes(table)).toEqual(maxes);
    expect(classifyImport(table).type).toBe('training-maxes');
  });

  it('writes a header alone for no rows', () => {
    expect(serializeTrainingMaxes([])).toBe('Date Updated,Lift,Weight');
  });
});

describe('serializeStrengthGoals', () => {
  const today = date('2026-11-06');

  it('reads back absolute and relative goals in either unit', () => {
    const table = parseCsvText(
      serializeStrengthGoals(
        [
          { lift: 'Squat', goalType: 'absolute', target: 315, ratio: null, unit: 'lbs' },
          { lift: 'Deadlift', goalType: 'absolute', target: 200, unit: 'kg' },
          { lift: 'Bench Press', goalType: 'relative', target: null, ratio: 1.5, unit: 'lbs' },
          { lift: 'Chin-up', goalType: 'relative', ratio: 0.5, unit: 'kg' },
          { lift: 'Weighted Dips', goalType: 'absolute', target: 90, unit: 'lbs' },
        ],
        today,
      ),
    );

    expect(parseStrengthGoals(table)).toEqual([
      { lift: 'Squat', goalType: 'absolute', target: 315, unit: 'lbs', updatedAt: today },
      { lift: 'Deadlift', goalType: 'absolute', target: 200, unit: 'kg', updatedAt: today },
      { lift: 'Bench Press', goalType: 'relative', ratio: 1.5, unit: 'lbs', updatedAt: today },
      { lift: 'Chin-up', goalType: 'relative', ratio: 0.5, unit: 'kg', updatedAt: today },
      { lift: 'Weighted Dips', goalType: 'absolute', target: 90, unit: 'lbs', updatedAt: today },
    ]);
    expect(classifyImport(table).type).toBe('strength-goals');
  });

  it.each(['Note Press', 'Note', "Today's Lift", 'Today', 'Start Date Squat', 'Goal Date', 'Weight'])(
    'keeps a goal on a custom lift named %s, though a ladder file uses words like it as labels',
    (lift) => {
      const table = parseCsvText(
        serializeStrengthGoals([{ lift, goalType: 'absolute', target: 200, unit: 'lbs' }], today),
      );
      expect(parseStrengthGoals(table)).toEqual([
        { lift, goalType: 'absolute', target: 200, unit: 'lbs', updatedAt: today },
      ]);
    },
  );

  it('writes a file with no goal rows that parses as empty and stays classified', () => {
    const table = parseCsvText(serializeStrengthGoals([], today));
    expect(parseStrengthGoals(table)).toEqual([]);
    expect(classifyImport(table).type).toBe('strength-goals');
  });

  it('still reads a sheet ladder with no Ratio or Unit column as absolute lbs', () => {
    const goals = parseStrengthGoals(
      parseCsvText(['Lift,Current TM,Intermediate,Advanced,Elite', 'Squat,250,280,350,420'].join('\n')),
    );
    expect(goals).toMatchObject([{ lift: 'Squat', goalType: 'absolute', target: 280, unit: 'lbs' }]);
  });

  it('keeps the tiers when a sheet shows a ratio beside them', () => {
    const goals = parseStrengthGoals(
      parseCsvText(['Lift,Current TM,Ratio,Intermediate,Advanced', 'Squat,250,1.5,280,350'].join('\n')),
    );
    expect(goals).toMatchObject([{ lift: 'Squat', goalType: 'absolute', target: 280 }]);
  });

  it('keeps the value of an older relative goal that holds a target and no ratio', () => {
    const table = parseCsvText(
      serializeStrengthGoals([{ lift: 'Squat', goalType: 'relative', target: 400, ratio: null, unit: 'lbs' }], today),
    );
    expect(parseStrengthGoals(table)).toMatchObject([{ lift: 'Squat', target: 400 }]);
  });
});

describe('serializeProgramSpec', () => {
  const spec = {
    week: 1,
    offset: 0,
    lift: 'Bench Press',
    increment: 2.5,
    order: 1,
    sets: 3,
    reps: 8,
    amrap: true,
    warmUpPct: '.4,.6,.8',
    wtDecrementPct: 0.05,
    activation: 'Band Flye',
    weekType: 'training',
  };

  it('reads back through parseLiftingProgramSpec and is classified', () => {
    const table = parseCsvText(serializeProgramSpec([spec]));
    expect(parseLiftingProgramSpec(table)).toEqual([spec]);
    expect(classifyImport(table).type).toBe('program-spec');
  });

  it('escapes a week type, which the custom-program API accepts as free text', () => {
    const [, row] = parseCsvText(serializeProgramSpec([{ ...spec, weekType: '=HYPERLINK("x")' }]));
    expect(row![row!.length - 1]).toBe(`'=HYPERLINK("x")`);
  });

  it('leaves a missing week type empty, which the parser defaults', () => {
    const table = parseCsvText(serializeProgramSpec([{ ...spec, amrap: 'FALSE', weekType: null }]));
    expect(parseLiftingProgramSpec(table)).toEqual([{ ...spec, amrap: false, weekType: 'training' }]);
  });
});
