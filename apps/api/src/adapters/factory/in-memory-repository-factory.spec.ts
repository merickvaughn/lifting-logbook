import { emptyFocusDayState } from '@lifting-logbook/types';
import { RepositoryBundle } from '../../ports/factory';
import { seedMacrocycleDashboard } from '../in-memory/fixtures';
import { numberedStoresIn } from '../in-memory/renumber';
import { NUMBERED_TABLES } from '../prisma/macrocycle.repository';
import { InMemoryRepositoryFactory } from './in-memory-repository-factory';

const PROGRAM = '5-3-1';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** One row on `macrocycleNum` in every store of the bundle that holds a number. */
async function seedEveryStore(repos: RepositoryBundle, macrocycleNum = 1, program = PROGRAM): Promise<void> {
  await repos.macrocycle.create({ program, macrocycleNum, startDate: day('2026-01-05'), status: 'in-progress', origin: 'live' });
  await repos.liftRecord.appendLiftRecords(program, [
    { program, macrocycleNum, workoutNum: 1, date: day('2026-01-05'), lift: 'Squat', setNum: 1, weight: 200, reps: 5, notes: '' },
  ]);
  await repos.macrocycleDashboard.saveMacrocycleDashboard({ ...seedMacrocycleDashboard(), program, macrocycleNum });
  await repos.macrocycleScheduledWorkout.saveScheduledWorkouts(program, macrocycleNum, [{ workoutNum: 1, weekNum: 1, scheduledDate: day('2026-01-05') }]);
  await repos.workoutDateOverride.upsertOverride(program, macrocycleNum, 1, day('2026-01-06'));
  await repos.workoutSkipOverride.skipWorkout(program, macrocycleNum, 2);
  await repos.workoutLiftOverride.upsertOverride(program, macrocycleNum, 1, { lift: 'Dips', action: 'add' });
  await repos.focus.saveDayState(program, macrocycleNum, 1, emptyFocusDayState());
}

/** Which of the stores hold anything on `macrocycleNum`. */
async function storesOn(repos: RepositoryBundle, macrocycleNum: number, program = PROGRAM): Promise<string[]> {
  const held = {
    macrocycle: (await repos.macrocycle.findByNumber(program, macrocycleNum)) !== null,
    liftRecord: (await repos.liftRecord.getLiftRecords(program, macrocycleNum)).length > 0,
    dashboard: (await repos.macrocycleDashboard.getMacrocycleDashboard(program).catch(() => null))?.macrocycleNum === macrocycleNum,
    scheduled: (await repos.macrocycleScheduledWorkout.getScheduledWorkouts(program, macrocycleNum)).length > 0,
    dateOverride: (await repos.workoutDateOverride.getOverridesForMacrocycle(program, macrocycleNum)).size > 0,
    skip: (await repos.workoutSkipOverride.getSkipsForMacrocycle(program, macrocycleNum)).size > 0,
    liftOverride: (await repos.workoutLiftOverride.getOverrides(program, macrocycleNum, 1)).length > 0,
    focus: (await repos.focus.getDayState(program, macrocycleNum, 1)) !== null,
  };
  return Object.entries(held).filter(([, on]) => on).map(([store]) => store);
}

const EVERY_STORE = ['macrocycle', 'liftRecord', 'dashboard', 'scheduled', 'dateOverride', 'skip', 'liftOverride', 'focus'];

describe('InMemoryRepositoryFactory macrocycle wiring (#1199)', () => {
  it('rewrites a number in every store that holds one, as the Prisma adapter rewrites every table', async () => {
    const repos = await new InMemoryRepositoryFactory().forUser({ id: 'wiring-rewrite', email: 'w@example.com', provider: 'dev' });
    await seedEveryStore(repos);
    expect(await storesOn(repos, 1)).toEqual(EVERY_STORE);

    expect(await repos.macrocycle.rewriteNumbers(PROGRAM, new Map([[1, 2]]))).toBe(8);

    expect(await storesOn(repos, 1)).toEqual([]);
    expect(await storesOn(repos, 2)).toEqual(EVERY_STORE);
  });

  it('deletes a macrocycle from every store', async () => {
    const repos = await new InMemoryRepositoryFactory().forUser({ id: 'wiring-delete', email: 'w@example.com', provider: 'dev' });
    await seedEveryStore(repos);

    await repos.macrocycle.delete(PROGRAM, [1]);

    expect(await storesOn(repos, 1)).toEqual([]);
  });

  it('deletes every number but the kept ones from every store, leaving other programs alone', async () => {
    const repos = await new InMemoryRepositoryFactory().forUser({ id: 'wiring-delete-all', email: 'w@example.com', provider: 'dev' });
    await seedEveryStore(repos, 2);
    await seedEveryStore(repos, 1, 'other');
    // A focus state on a number with no macrocycle goes too.
    await repos.focus.saveDayState(PROGRAM, 3, 1, emptyFocusDayState());
    // Imported history on 1, which the delete keeps.
    await repos.macrocycle.create({ program: PROGRAM, macrocycleNum: 1, startDate: day('2025-01-06'), status: 'completed', origin: 'imported' });
    await repos.liftRecord.appendLiftRecords(PROGRAM, [
      { program: PROGRAM, macrocycleNum: 1, workoutNum: 1, date: day('2025-01-06'), lift: 'Squat', setNum: 1, weight: 999, reps: 5, notes: '' },
    ]);

    await repos.macrocycle.deleteAllExcept(PROGRAM, [1]);

    expect(await storesOn(repos, 1)).toEqual(['macrocycle', 'liftRecord']);
    expect(await storesOn(repos, 2)).toEqual([]);
    expect(await storesOn(repos, 3)).toEqual([]);
    expect(await storesOn(repos, 1, 'other')).toEqual(EVERY_STORE);
  });

  it('wires in a store for every table that holds a number, besides the macrocycle table', async () => {
    const repos = await new InMemoryRepositoryFactory().forUser({ id: 'wiring-tables', email: 'w@example.com', provider: 'dev' });
    const tables = numberedStoresIn(repos).map((store) => store.table);
    expect(tables.sort()).toEqual(NUMBERED_TABLES.filter((t) => t !== 'macrocycle').sort());
  });
});
