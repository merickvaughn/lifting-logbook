import { BadRequestException } from '@nestjs/common';
import { liftRecordNaturalKey } from '@lifting-logbook/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { TRAINING_TABLES, TrainingData, TrainingRow } from '../ports/ITrainingDataRepository';
import { parseOverwrite, parseOverwriteRange, planOverwrite } from './import-overwrite';
import { NON_CYCLE_ROW_KEY } from './macrocycle-history.util';

type SetKey = Parameters<typeof liftRecordNaturalKey>[0];

const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

function dataWith(rows: Partial<TrainingData>): TrainingData {
  const data = Object.fromEntries(TRAINING_TABLES.map((table) => [table, []])) as unknown as TrainingData;
  return { ...data, ...rows };
}

const macrocycle = (macrocycleNum: number, start: string, end: string | null, origin = 'imported', program = 'rpt'): TrainingRow => ({
  id: `m-${program}-${macrocycleNum}`,
  program,
  macrocycleNum,
  startDate: day(start),
  endDate: end === null ? null : day(end),
  status: 'completed',
  statusChosen: false,
  origin,
});

const set = (macrocycleNum: number, workoutNum: number, date: string, program = 'rpt'): TrainingRow & SetKey => ({
  program,
  macrocycleNum,
  workoutNum,
  date: day(date),
  lift: 'bench-press',
  setNum: 1,
  weight: 100,
  reps: 5,
  notes: '',
  occurrence: 0,
  modifications: [],
});

describe('planOverwrite (#1182)', () => {
  // Macrocycle 1 runs 1 to 10 March, 2 is current from 20 March, 3 sits wholly in April with no sets.
  const data = dataWith({
    macrocycles: [
      macrocycle(1, '2026-03-01', '2026-03-10'),
      macrocycle(2, '2026-03-20', null, 'live'),
      macrocycle(3, '2026-04-02', '2026-04-05'),
      macrocycle(1, '2026-01-01', '2026-01-01', 'imported', NON_CYCLE_PROGRAM),
    ],
    liftRecords: [
      set(1, 1, '2026-03-01'),
      set(1, 2, '2026-03-05'),
      set(1, 3, '2026-03-10'),
      set(2, 1, '2026-03-20'),
      set(2, 2, '2026-03-25'),
      set(1, 1, '2026-03-06', NON_CYCLE_PROGRAM),
    ],
    macrocycleDashboards: [{ program: 'rpt', macrocycleNum: 2, macrocycleDate: day('2026-03-20'), macrocycleStartWeekday: 'Friday' }],
  });

  it('shortens a macrocycle at the range’s start and at its end, and moves a cut current start', () => {
    const plan = planOverwrite(data, { kind: 'range', from: '2026-03-06', to: '2026-03-22' });
    expect(plan.shortened.map((s) => [s.before.macrocycleNum, s.startDate, s.endDate])).toEqual([
      [1, day('2026-03-01'), day('2026-03-05')],
      [2, day('2026-03-25'), null],
    ]);
    expect(plan.dashboards).toEqual([expect.objectContaining({ program: 'rpt', macrocycleDate: day('2026-03-20'), to: day('2026-03-25') })]);
    // The non-cycle set on the 6th goes; its shared macrocycle doesn't.
    expect(plan.counts).toEqual({ sets: 3, macrocycles: 0, current: 0, shortened: 2 });
    expect(plan.removedNums.size).toBe(0);
  });

  it('removes a macrocycle the range empties, and one with no sets lying wholly inside it', () => {
    const plan = planOverwrite(data, { kind: 'range', from: '2026-03-15', to: '2026-04-30' });
    expect([...plan.removedNums]).toEqual([['rpt', [2, 3]]]);
    expect(plan.counts).toEqual({ sets: 2, macrocycles: 2, current: 1, shortened: 0 });
  });

  it('keeps a macrocycle with no sets that only partly lies inside the range', () => {
    const plan = planOverwrite(data, { kind: 'range', from: '2026-04-04', to: '2026-04-30' });
    expect(plan.counts).toEqual({ sets: 0, macrocycles: 0, current: 0, shortened: 0 });
  });

  it('drops the batch keys naming what goes, and keeps a training max’s', () => {
    const removedSet = set(1, 3, '2026-03-10');
    const keptSet = set(1, 1, '2026-03-01');
    const nonCycle = set(1, 1, '2026-03-06', NON_CYCLE_PROGRAM);
    const batch = {
      id: 'b-1',
      program: 'rpt',
      destination: 'lift-records',
      preImage: {
        [liftRecordNaturalKey(removedSet)]: { kind: 'created' },
        [liftRecordNaturalKey(keptSet)]: { kind: 'created' },
        [`${NON_CYCLE_ROW_KEY}${liftRecordNaturalKey(nonCycle)}`]: { kind: 'created' },
        'bench-press': { kind: 'created' },
      },
    };
    const plan = planOverwrite({ ...data, importBatches: [batch] }, { kind: 'range', from: '2026-03-06', to: '2026-03-10' });
    expect(plan.batchUpdates).toEqual([
      { id: 'b-1', preImage: { [liftRecordNaturalKey(keptSet)]: { kind: 'created' }, 'bench-press': { kind: 'created' } } },
    ]);
    expect(Object.keys(plan.removed.importBatches[0]?.['preImage'] as object)).toHaveLength(2);
  });

  it('counts the sets and macrocycles of every program under all history, not the non-cycle macrocycle', () => {
    expect(planOverwrite(data, { kind: 'all' }).counts).toEqual({ sets: 6, macrocycles: 3, current: 1, shortened: 0 });
  });
});

describe('parseOverwrite (#1182)', () => {
  const counts = { sets: 1, macrocycles: 0, current: 0, shortened: 2 };

  it('reads each scope and the confirmed counts, and nothing else', () => {
    expect(parseOverwrite(undefined)).toBeUndefined();
    expect(parseOverwrite({ scope: { kind: 'all' }, counts: { ...counts, extra: 1 } })).toEqual({ scope: { kind: 'all' }, counts });
    expect(parseOverwrite({ scope: { kind: 'range', from: '2026-01-01', to: '2026-01-01', extra: 1 }, counts })).toEqual({
      scope: { kind: 'range', from: '2026-01-01', to: '2026-01-01' },
      counts,
    });
  });

  it.each([
    ['no scope', { counts }],
    ['an unknown kind', { scope: { kind: 'some' }, counts }],
    ['a range with no end', { scope: { kind: 'range', from: '2026-01-01' }, counts }],
    ['a day that does not exist', { scope: { kind: 'range', from: '2026-02-30', to: '2026-03-01' }, counts }],
    ['a count missing', { scope: { kind: 'all' }, counts: { sets: 1, macrocycles: 0, current: 0 } }],
    ['a negative count', { scope: { kind: 'all' }, counts: { ...counts, sets: -1 } }],
    ['a fractional count', { scope: { kind: 'all' }, counts: { ...counts, sets: 1.5 } }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseOverwrite(value)).toThrow(BadRequestException);
  });

  it('refuses a range that ends before it starts', () => {
    expect(() => parseOverwriteRange('2026-02-02', '2026-02-01')).toThrow(BadRequestException);
    expect(parseOverwriteRange('2026-02-01', '2026-02-02')).toEqual({ from: '2026-02-01', to: '2026-02-02' });
  });
});
