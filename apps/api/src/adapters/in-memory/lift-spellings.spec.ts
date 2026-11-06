import { InMemoryLiftRecordRepository } from './lift-record.adapter';
import { InMemoryTrainingMaxHistoryRepository } from './training-max-history.adapter';

const JAN = new Date('2026-01-10T00:00:00.000Z');

// #1135: the in-memory adapters answer a query by lift as the Prisma ones do
// (focus.db.e2e.spec.ts holds the real-database test).
describe('a query by lift, across stored spellings', () => {
  it('getRecordsForLifts finds every spelling, and keeps how each is stored', async () => {
    const repository = new InMemoryLiftRecordRepository(new Map());
    const record = (lift: string, weight: number) => ({
      program: 'p',
      macrocycleNum: 1,
      workoutNum: 1,
      date: JAN,
      lift,
      setNum: 1,
      weight,
      reps: 5,
      notes: '',
    });
    await repository.appendLiftRecords('p', [
      record('Bench Press', 200),
      record('bench-press', 210),
      record('Bench P.', 220),
      record('Back Squat', 300),
    ]);

    const records = await repository.getRecordsForLifts(['Bench Press'], JAN);
    expect(records.map((r) => r.lift).sort()).toEqual(['Bench P.', 'Bench Press', 'bench-press']);
  });

  it('getHistory filters to every spelling of the lift', async () => {
    const repository = new InMemoryTrainingMaxHistoryRepository();
    const entry = (lift: string) => ({
      lift,
      weight: 100,
      unit: 'lbs' as const,
      date: JAN,
      isPR: false,
      source: 'program' as const,
      goalMet: false,
    });
    await repository.appendHistoryEntries('p', [entry('Bench Press'), entry('bench-press'), entry('Back Squat')]);

    const entries = await repository.getHistory('p', { lift: 'Bench Press' });
    expect(entries.map((e) => e.lift).sort()).toEqual(['Bench Press', 'bench-press']);
  });
});
