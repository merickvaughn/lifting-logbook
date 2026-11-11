import { emptyFocusDayState } from '@lifting-logbook/types';
import { RepositoryBundle } from '../../ports/factory';
import { seedMacrocycleDashboard } from '../in-memory/fixtures';
import { InMemoryRepositoryFactory } from './in-memory-repository-factory';

const PROGRAM = '5-3-1';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** One row on macrocycle 1 in every store of the bundle that holds a number. */
async function seedEveryStore(repos: RepositoryBundle): Promise<void> {
  await repos.macrocycle.create({ program: PROGRAM, macrocycleNum: 1, startDate: day('2026-01-05'), status: 'in-progress', origin: 'live' });
  await repos.liftRecord.appendLiftRecords(PROGRAM, [
    { program: PROGRAM, macrocycleNum: 1, workoutNum: 1, date: day('2026-01-05'), lift: 'Squat', setNum: 1, weight: 200, reps: 5, notes: '' },
  ]);
  await repos.macrocycleDashboard.saveMacrocycleDashboard({ ...seedMacrocycleDashboard(), program: PROGRAM, macrocycleNum: 1 });
  await repos.macrocycleScheduledWorkout.saveScheduledWorkouts(PROGRAM, 1, [{ workoutNum: 1, weekNum: 1, scheduledDate: day('2026-01-05') }]);
  await repos.workoutDateOverride.upsertOverride(PROGRAM, 1, 1, day('2026-01-06'));
  await repos.workoutSkipOverride.skipWorkout(PROGRAM, 1, 2);
  await repos.workoutLiftOverride.upsertOverride(PROGRAM, 1, 1, { lift: 'Dips', action: 'add' });
  await repos.focus.saveDayState(PROGRAM, 1, 1, emptyFocusDayState());
}

/** Which of the stores hold anything on `macrocycleNum`. */
async function storesOn(repos: RepositoryBundle, macrocycleNum: number): Promise<string[]> {
  const held = {
    macrocycle: (await repos.macrocycle.findByNumber(PROGRAM, macrocycleNum)) !== null,
    liftRecord: (await repos.liftRecord.getLiftRecords(PROGRAM, macrocycleNum)).length > 0,
    dashboard: (await repos.macrocycleDashboard.getMacrocycleDashboard(PROGRAM).catch(() => null))?.macrocycleNum === macrocycleNum,
    scheduled: (await repos.macrocycleScheduledWorkout.getScheduledWorkouts(PROGRAM, macrocycleNum)).length > 0,
    dateOverride: (await repos.workoutDateOverride.getOverridesForMacrocycle(PROGRAM, macrocycleNum)).size > 0,
    skip: (await repos.workoutSkipOverride.getSkipsForMacrocycle(PROGRAM, macrocycleNum)).size > 0,
    liftOverride: (await repos.workoutLiftOverride.getOverrides(PROGRAM, macrocycleNum, 1)).length > 0,
    focus: (await repos.focus.getDayState(PROGRAM, macrocycleNum, 1)) !== null,
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
});
