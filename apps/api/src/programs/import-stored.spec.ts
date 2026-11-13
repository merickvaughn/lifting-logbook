import type { KnownProgram, LiftRecord } from '@lifting-logbook/core';
import { InMemoryLiftRecordRepository } from '../adapters/in-memory/lift-record.adapter';
import { InMemoryMacrocycleRepository, macrocycleRowFixture } from '../adapters/in-memory/macrocycle.adapter';
import { MacrocycleRow, NewMacrocycle } from '../ports/IMacrocycleRepository';
import {
  HeldWorkouts,
  StretchToPlace,
  continuedWorkoutNum,
  placeOnStored,
  recomputeMacrocycles,
  unwrittenFields,
} from './import-stored';

/**
 * Decision 14's placement rule, one case per edge (#1255). The API end-to-end tests in
 * `import-breakdown.e2e.spec.ts` cover the same rule through `mode=assign` and the commit.
 */
const at = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

const program = (id: string, workoutCount: number): KnownProgram => ({
  id,
  lifts: new Set(),
  workoutCount,
  lengthWeeks: 4,
  setOrder: new Map(),
});
// `rpt` and `5-3-1` are built-in ids; `my-plan` is a custom program, so open-ended.
const PROGRAMS = [program('rpt', 9), program('5-3-1', 9), program('my-plan', 0)];

function setup() {
  const liftRecord = new InMemoryLiftRecordRepository(new Map());
  const macrocycle = new InMemoryMacrocycleRepository();
  macrocycle.attachNumbered([liftRecord]);
  return { macrocycle, liftRecord };
}
type Repos = ReturnType<typeof setup>;

const set = (prog: string, macrocycleNum: number, workoutNum: number, day: number): LiftRecord => ({
  program: prog,
  macrocycleNum,
  workoutNum,
  date: at(day),
  lift: 'Squat',
  setNum: 1,
  weight: 100,
  reps: 5,
  notes: '',
});

/**
 * A stored macrocycle with one session every other day from `from`, workouts numbered from 1. It
 * ends on its last session unless `endDate` says otherwise; null leaves it open, as a `live` row is.
 */
async function seed(
  repos: Repos,
  m: { program: string; num: number; from: number; sessions: number; endDate?: Date | null } & Partial<
    Omit<NewMacrocycle, 'program' | 'macrocycleNum' | 'endDate'>
  >,
): Promise<MacrocycleRow> {
  const { program: prog, num, from, sessions, endDate, ...rest } = m;
  const days = Array.from({ length: sessions }, (_, i) => from + i * 2);
  const row = await repos.macrocycle.create({
    program: prog,
    macrocycleNum: num,
    startDate: at(from),
    ...(endDate === null ? {} : { endDate: endDate ?? at(from + (sessions - 1) * 2) }),
    status: 'in-progress',
    origin: 'imported',
    ...rest,
  });
  await repos.liftRecord.appendLiftRecords(prog, days.map((d, i) => set(prog, num, i + 1, d)));
  return row;
}

/** A stretch of `prog` from day `from` to `to`, creating a row on each of `creating`. */
const stretch = (prog: string, from: number, to: number, creating: number[] = [to], workoutNum: number | null = null): StretchToPlace => ({
  program: prog,
  span: { startDate: at(from), endDate: at(to) },
  creating: creating.map((d) => ({ date: at(d), workoutNum })),
});

const kinds = async (repos: Repos, stretches: StretchToPlace[], programs = PROGRAMS) =>
  (await placeOnStored(repos, stretches, programs)).map(({ placement }) => placement.kind);

describe('placeOnStored (#1255, decision 14)', () => {
  it('joins a run that ended exactly 14 days before, and not one 15 days before', async () => {
    const repos = setup();
    await seed(repos, { program: 'rpt', num: 1, from: 0, sessions: 3 });
    expect(await kinds(repos, [stretch('rpt', 18, 20)])).toEqual(['joins']);
    expect(await kinds(repos, [stretch('rpt', 19, 21)])).toEqual(['new']);
  });

  it("takes a file stretch ending the day a stored run does as the boundary, since it's the lifter's", async () => {
    const repos = setup();
    await seed(repos, { program: 'rpt', num: 1, from: 0, sessions: 3 });
    expect(await kinds(repos, [stretch('5-3-1', 4, 4), stretch('rpt', 10, 12)])).toEqual(['overlaps', 'new']);
  });

  it('lets only one stretch join a stored run; the next one over it overlaps', async () => {
    const repos = setup();
    await seed(repos, { program: 'rpt', num: 1, from: 0, sessions: 3 });
    expect(await kinds(repos, [stretch('rpt', 2, 8), stretch('rpt', 0, 6)])).toEqual(['overlaps', 'joins']);
  });

  it('joins an open-ended custom run whatever its count, and not a built-in run with every workout done', async () => {
    const repos = setup();
    await seed(repos, { program: 'my-plan', num: 1, from: 0, sessions: 12 });
    await seed(repos, { program: 'rpt', num: 1, from: 40, sessions: 9 });
    expect(await kinds(repos, [stretch('my-plan', 26, 28)])).toEqual(['joins']);
    // All 9 RPT workouts are in, though the run isn't marked `completed`.
    expect(await kinds(repos, [stretch('rpt', 60, 62)])).toEqual(['new']);
  });

  it('ends a live macrocycle with no end date at its last set, so a later stretch can still join', async () => {
    const repos = setup();
    await seed(repos, { program: '5-3-1', num: 1, from: 0, sessions: 2, origin: 'live', endDate: null });
    await seed(repos, { program: 'rpt', num: 1, from: 10, sessions: 3 });
    expect(await kinds(repos, [stretch('rpt', 20, 22)])).toEqual(['joins']);
  });

  it("reads a legacy macrocycle's span from its sets as well as its stored dates", async () => {
    const repos = setup();
    // Stored as days 0 to 4, holding sets up to day 12.
    await seed(repos, { program: '5-3-1', num: 1, from: 0, sessions: 7, origin: 'legacy', endDate: at(4) });
    const [placed] = await placeOnStored(repos, [stretch('rpt', 8, 10)], PROGRAMS);
    expect(placed?.placement).toMatchObject({ kind: 'overlaps', macrocycles: [{ program: '5-3-1', macrocycleNum: 1 }] });
  });

  it('breaks a tie between stored runs ending the same day for the run of the stretch’s program, in any store order', async () => {
    for (const order of [['5-3-1', 'rpt'], ['rpt', '5-3-1']]) {
      const repos = setup();
      for (const prog of order) await seed(repos, { program: prog, num: 1, from: 0, sessions: 3 });
      expect(await kinds(repos, [stretch('rpt', 10, 12)])).toEqual(['joins']);
    }
  });

  it('reads the held workouts of the run it joins, by date', async () => {
    const repos = setup();
    await seed(repos, { program: 'rpt', num: 1, from: 0, sessions: 3 });
    const [placed] = await placeOnStored(repos, [stretch('rpt', 0, 6, [2, 6])], PROGRAMS);
    expect(placed?.placement).toMatchObject({ kind: 'joins', held: { highest: 3, count: 3 } });
    if (placed?.placement.kind !== 'joins') return;
    expect([...placed.placement.held.byDate]).toEqual([
      [at(0).getTime(), 1],
      [at(2).getTime(), 2],
      [at(4).getTime(), 3],
    ]);
  });
});

describe('continuedWorkoutNum (#1255, decision 9)', () => {
  const held: HeldWorkouts = { byDate: new Map([[at(0).getTime(), 1], [at(2).getTime(), 2]]), highest: 2, count: 2 };

  it("keeps the file's numbers, gives a held date its workout, and numbers other new dates past the highest", () => {
    const rows = [
      { date: at(2), workoutNum: NaN },
      { date: at(6), workoutNum: 9 },
      { date: at(4), workoutNum: NaN },
      { date: at(8), workoutNum: NaN },
      { date: at(4), workoutNum: NaN },
    ];
    const next = continuedWorkoutNum(rows.map((r) => ({ date: r.date, workoutNum: Number.isNaN(r.workoutNum) ? null : r.workoutNum })), held);
    expect(rows.map(next)).toEqual([2, 9, 3, 4, 3]);
  });

  it('refuses a row that is not one of the new rows', () => {
    expect(() => continuedWorkoutNum([], held)({ date: at(20), workoutNum: NaN })).toThrow();
  });
});

describe('recomputeMacrocycles (#1255)', () => {
  it('writes every date before reading any status, whatever order the ids come in', async () => {
    for (const reversed of [false, true]) {
      const repos = setup();
      // Both rows' stored dates are stale: RPT's sets end on day 4, and 5/3/1's start on day 10.
      const rpt = await seed(repos, { program: 'rpt', num: 1, from: 0, sessions: 3, endDate: at(30) });
      const fiveThreeOne = await seed(repos, { program: '5-3-1', num: 1, from: 10, sessions: 2, startDate: at(2) });
      const ids = reversed ? [fiveThreeOne.id, rpt.id] : [rpt.id, fiveThreeOne.id];
      expect(await recomputeMacrocycles(repos, ids, PROGRAMS, at(14))).toBe(2);
      // 5/3/1 now starts after RPT's last set, so RPT is abandoned for it.
      expect(await repos.macrocycle.findById(rpt.id)).toMatchObject({ startDate: at(0), endDate: at(4), status: 'abandoned' });
      expect(await repos.macrocycle.findById(fiveThreeOne.id)).toMatchObject({ startDate: at(10), endDate: at(12), status: 'in-progress' });
    }
  });

  it('keeps a chosen status and skips a macrocycle that is not imported or has no sets', async () => {
    const repos = setup();
    const chosen = await seed(repos, { program: 'rpt', num: 1, from: 0, sessions: 3, status: 'overran', statusChosen: true });
    const live = await seed(repos, { program: '5-3-1', num: 1, from: 0, sessions: 2, origin: 'live', endDate: null });
    const empty = await repos.macrocycle.create({ program: 'rpt', macrocycleNum: 2, startDate: at(20), status: 'in-progress', origin: 'imported' });
    expect(await recomputeMacrocycles(repos, [chosen.id, live.id, empty.id], PROGRAMS, at(14))).toBe(1);
    expect(await repos.macrocycle.findById(chosen.id)).toMatchObject({ status: 'overran', statusChosen: true });
    expect(await repos.macrocycle.findById(live.id)).toEqual(live);
    expect(await repos.macrocycle.findById(empty.id)).toEqual(empty);
  });
});

describe('unwrittenFields (#1255)', () => {
  const row = (overrides: Partial<MacrocycleRow>) => macrocycleRowFixture(1, overrides);
  const before = { status: 'in-progress', statusChosen: false, unmatched: false } as const;
  const wrote = { status: 'abandoned', statusChosen: true, unmatched: true } as const;

  it('puts back each field still as the join wrote it', () => {
    expect(unwrittenFields(row(wrote), before, wrote)).toEqual(before);
    expect(unwrittenFields(row({ ...wrote, unmatched: false }), before, wrote)).toEqual({ status: 'in-progress', statusChosen: false });
  });

  it('keeps a status the lifter chose since, with its chosen flag', () => {
    expect(unwrittenFields(row({ ...wrote, status: 'completed' }), before, wrote)).toEqual({ unmatched: false });
  });

  it('puts back nothing the join left alone', () => {
    expect(unwrittenFields(row(wrote), {}, {})).toEqual({});
    expect(unwrittenFields(row({ statusChosen: true }), { statusChosen: false }, { statusChosen: true })).toEqual({ statusChosen: false });
  });
});
