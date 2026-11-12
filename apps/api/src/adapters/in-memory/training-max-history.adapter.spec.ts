import { InMemoryTrainingMaxHistoryRepository } from './training-max-history.adapter';

// The Prisma adapter's filter runs against Postgres in lift-modification.db.e2e.spec.ts.
describe('InMemoryTrainingMaxHistoryRepository — own-max entries (#1153)', () => {
  const entry = {
    lift: 'cable-curl',
    weight: 68.75,
    reps: 1,
    date: new Date('2026-04-20'),
    isPR: false,
    source: 'program' as const,
    goalMet: false,
  };

  it("leaves a modification's own-max entries out of the lift's history, with or without filters", async () => {
    const repo = new InMemoryTrainingMaxHistoryRepository();
    await repo.appendHistoryEntries('rpt', [entry, { ...entry, weight: 65, modificationId: 'wide-grip' }]);

    expect((await repo.getHistory('rpt')).map((e) => e.weight)).toEqual([68.75]);
    expect((await repo.getHistory('rpt', { lift: 'Cable Curl', source: 'program' })).map((e) => e.weight)).toEqual([
      68.75,
    ]);
  });

  it('deletes own-max entries with the rest of the program', async () => {
    const repo = new InMemoryTrainingMaxHistoryRepository();
    await repo.appendHistoryEntries('rpt', [{ ...entry, modificationId: 'wide-grip' }]);

    await repo.deleteAllHistory('rpt');

    // The read hides the entry either way, so look it up by id.
    await expect(repo.updateHistoryEntry('rpt', '1', { isPR: true })).rejects.toThrow();
  });
});
