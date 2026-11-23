import { Logger } from '@nestjs/common';
import { SupplementChange } from '@lifting-logbook/types';
import { InMemoryRepositoryFactory } from '../adapters/factory/in-memory-repository-factory';
import { InMemorySupplementRepository } from '../adapters/in-memory/supplement.adapter';
import { AuthUser } from '../ports/auth';
import { SupplementsController } from './supplements.controller';

const user: AuthUser = { id: 'supplements-as-of-spec', email: 'a@example.com', provider: 'dev' };
const SECRET = 'Private note about a prescription';

/** A log replay can't fully apply: a change to an item it never added. */
const log: SupplementChange[] = [
  {
    date: '2026-11-01',
    seq: 1,
    type: 'added',
    item: {
      id: 'a',
      name: SECRET,
      keyCompound: '',
      timing: '',
      shortNote: SECRET,
      longNote: '',
      status: 'active',
      unverified: false,
      links: [],
      category: '',
      typicalRange: '',
      ingredients: [],
      doses: [],
    },
  },
  { date: '2026-11-02', seq: 2, type: 'started', itemId: 'ghost' },
];

class AnomalousLog extends InMemorySupplementRepository {
  override async changesThrough(date: string): Promise<SupplementChange[]> {
    return log.filter((c) => c.date <= date);
  }

  override async firstChangeDate(): Promise<string | null> {
    return '2026-11-01';
  }
}

describe('SupplementsController as-of', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the first change date and the anomalies, and logs the anomalies as a warning with ids only', async () => {
    const factory = new InMemoryRepositoryFactory();
    (await factory.forUser(user)).supplement = new AnomalousLog();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const res = await new SupplementsController(factory, { noteWrite: () => undefined } as never).asOf('2026-11-02', user);

    expect(res.items.map((i) => i.id)).toEqual(['a']);
    expect(res.firstChangeDate).toBe('2026-11-01');
    expect(res.anomalies).toEqual([{ seq: 2, type: 'started', itemId: 'ghost', reason: 'unknown-item' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('"itemId":"ghost"');
    expect(logged).toContain('"reason":"unknown-item"');
    expect(logged).not.toContain(SECRET);
  });

  it('logs nothing for a log that replays cleanly', async () => {
    const factory = new InMemoryRepositoryFactory();
    (await factory.forUser(user)).supplement = new AnomalousLog();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const res = await new SupplementsController(factory, { noteWrite: () => undefined } as never).asOf('2026-11-01', user);

    expect(res.anomalies).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
