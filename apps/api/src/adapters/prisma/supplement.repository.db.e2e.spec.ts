// Real-Postgres E2E for the supplement repository (#1374, ADR-046): the per-user write lock, the
// all-or-nothing save, and the reads that only Postgres can answer (the JSON-path restore lookup,
// the as-of filter). Runs as the restricted lifting_app role, inside a transaction with the RLS
// user set, as a request does. Each test has its own user, so no test depends on another's rows.
import { PrismaClient } from '@prisma/client';
import { SupplementChangeBody, applyChange, stackAsOf } from '@lifting-logbook/core';
import { SupplementItem } from '@lifting-logbook/types';
import { SupplementWriteConflictError } from '../../ports/errors';
import { NewSupplementChange, SupplementState } from '../../ports/ISupplementRepository';
import { PrismaSupplementRepository, SUPPLEMENT_LOCK_NAMESPACE } from './supplement.repository';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_TC_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_TC_URL ? describe : describe.skip;
// Only read inside the guarded describe, where both are set.
const OWNER_URL = OWNER_TC_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';
// See rls.db.e2e.spec.ts: a contended Windows run can pass Jest's 5s default hook timeout (#567).
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;
// The tests that hold the lock wait on other transactions, so they get the same budget. Each
// transaction has the request's 15 s, and polling for a queued write gives up after 10 s.
const TEST_TIMEOUT_MS = 30_000;
const TX_TIMEOUT_MS = 15_000;
const QUEUE_WAIT_MS = 10_000;
const TODAY = '2026-11-20';

const item = (id: string, p: Partial<SupplementItem> = {}): SupplementItem => ({
  id,
  name: id,
  keyCompound: '',
  timing: '',
  shortNote: '',
  longNote: '',
  status: 'active',
  unverified: false,
  links: [],
  ingredients: [{ key: 'caffeine', amount: 100, unit: 'mg' }],
  doses: [{ slot: 'am', amount: '1', servings: 1, dayTypes: [] }],
  ...p,
});

/** Applies `changes` to `state` as the controller does, and dates them. */
function apply(state: SupplementState, changes: SupplementChangeBody[]): NewSupplementChange[] {
  for (const change of changes) expect(applyChange(state, change)).toEqual([]);
  return changes.map((change) => ({ ...change, date: TODAY }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
}

describeOrSkip('PrismaSupplementRepository (e2e, lifting_app role)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;
  let userCount = 0;
  let userId = '';

  /**
   * Runs `body` with a repository on a transaction scoped to this test's user, as a request does,
   * with the request transaction's 15 s budget. `lockWaitMs` shortens the write lock's wait.
   */
  const asUser = <T>(body: (repo: PrismaSupplementRepository) => Promise<T>, lockWaitMs?: number): Promise<T> =>
    appDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
        return body(new PrismaSupplementRepository(tx, userId, lockWaitMs));
      },
      { maxWait: 10_000, timeout: TX_TIMEOUT_MS },
    );

  /** Polls until another transaction waits on this test's user's write lock, for up to `withinMs`. */
  async function lockQueued(withinMs: number): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      const [waiting] = await owner.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${userId}, ${SUPPLEMENT_LOCK_NAMESPACE})`;
      if ((waiting?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
  }, DB_E2E_HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    userId = `supplement-repo-e2e-${process.pid}-${++userCount}`;
    const where = { userId };
    // Doses and mix parts cascade from their item.
    await owner.supplementItem.deleteMany({ where });
    await owner.supplementDayType.deleteMany({ where });
    await owner.supplementChange.deleteMany({ where });
    await owner.userSettings.deleteMany({ where });
  });

  afterAll(async () => {
    const where = { userId: { startsWith: `supplement-repo-e2e-${process.pid}-` } };
    await owner.supplementItem.deleteMany({ where });
    await owner.supplementDayType.deleteMany({ where });
    await owner.supplementChange.deleteMany({ where });
    await owner.userSettings.deleteMany({ where });
    await owner.$disconnect();
    await appDb.$disconnect();
  });

  it('makes a write wait for one in progress, so a write that changes only the cutoff keeps an add made meanwhile', async () => {
    const entered = deferred();
    const release = deferred();
    // Holds the lock, having loaded the state, until released.
    const cutoff = asUser((repo) =>
      repo.write(async (state) => {
        entered.resolve();
        await release.promise;
        return apply(state, [{ type: 'caffeine_cutoff_set', caffeineCutoff: '12:00' }]);
      }),
    );
    await entered.promise;
    const add = asUser((repo) => repo.write(async (state) => apply(state, [{ type: 'added', item: item('a') }])));

    // Wait until the add is queued on this user's lock; without the lock it never is, and saves
    // first, so the cutoff write then fails on its seq.
    let queued = false;
    try {
      queued = await lockQueued(QUEUE_WAIT_MS);
    } finally {
      release.resolve();
    }
    const settled = await Promise.allSettled([cutoff, add]);
    // Checked before the writes' outcomes, so a failure here names the missing wait.
    expect(queued).toBe(true);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);

    const stored = await asUser((repo) => repo.load());
    expect(stored.items.map((i) => i.id)).toEqual(['a']);
    expect(stored.caffeineCutoff).toBe('12:00');
    const log = await asUser((repo) => repo.changes({ limit: 10 }));
    expect(log.map((c) => [c.seq, c.type])).toEqual([
      [1, 'caffeine_cutoff_set'],
      [2, 'added'],
    ]);
  }, TEST_TIMEOUT_MS);

  it('answers a write that waits too long for the lock as a conflict, and stores nothing for it', async () => {
    const entered = deferred();
    const release = deferred();
    const holder = asUser((repo) =>
      repo.write(async (state) => {
        entered.resolve();
        await release.promise;
        return apply(state, [{ type: 'added', item: item('held') }]);
      }),
    );
    await entered.promise;
    // A 200 ms wait stands in for the 5 s one, which a stuck holder would run out. Unbounded, the
    // write would wait for as long as the holder holds the lock, and this test would time out.
    const late = asUser((repo) => repo.write(async (state) => apply(state, [{ type: 'added', item: item('late') }])), 200);
    try {
      await expect(late).rejects.toBeInstanceOf(SupplementWriteConflictError);
    } finally {
      release.resolve();
    }
    await holder;

    expect(await owner.supplementItem.findMany({ where: { userId }, select: { id: true } })).toEqual([{ id: 'held' }]);
    expect(await owner.supplementChange.count({ where: { userId } })).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('puts lock_timeout back once the lock is taken, so the rest of the request keeps its own', async () => {
    const timeouts = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      await tx.$executeRaw`SELECT set_config('lock_timeout', '7s', true)`;
      await new PrismaSupplementRepository(tx, userId).write(async (state) => apply(state, [{ type: 'added', item: item('a') }]));
      return tx.$queryRaw<{ value: string }[]>`SELECT current_setting('lock_timeout') AS value`;
    });
    expect(timeouts).toEqual([{ value: '7s' }]);
  });

  it('stores neither the rows nor the log entry of a write a lock-skipping writer beat to its seq', async () => {
    await asUser((repo) => repo.write(async (state) => apply(state, [{ type: 'added', item: item('kept') }])));
    const write = asUser((repo) =>
      repo.write(async (state) => {
        // A writer that skips the lock, such as a script, appends the seq this write read.
        await owner.supplementChange.create({
          data: { userId, seq: state.nextSeq, date: new Date(TODAY), type: 'mix_split', payload: { mixId: 'x' } },
        });
        return apply(state, [{ type: 'added', item: item('lost') }]);
      }),
    );

    await expect(write).rejects.toThrow(SupplementWriteConflictError);
    expect(await owner.supplementItem.findMany({ where: { userId }, select: { id: true } })).toEqual([{ id: 'kept' }]);
    expect(await owner.supplementDose.count({ where: { userId, itemId: 'lost' } })).toBe(0);
    expect((await owner.supplementChange.findMany({ where: { userId }, orderBy: { seq: 'asc' } })).map((c) => c.type)).toEqual([
      'added',
      'mix_split',
    ]);
  });

  it('answers a key collision on the stack rows as a conflict, not a 500, and stores nothing', async () => {
    const write = asUser((repo) =>
      repo.write(async (state) => {
        const changes = apply(state, [{ type: 'added', item: item('dup') }]);
        // Two rows on one (userId, id): the item key, not the change log's, refuses the save.
        state.items.push(item('dup'));
        return changes;
      }),
    );

    await expect(write).rejects.toThrow(SupplementWriteConflictError);
    expect(await owner.supplementItem.count({ where: { userId } })).toBe(0);
    expect(await owner.supplementChange.count({ where: { userId } })).toBe(0);
  });

  it('saves nothing for a write that changes nothing, and refuses one that changes the stack without a change', async () => {
    await asUser((repo) => repo.write(async (state) => apply(state, [{ type: 'added', item: item('a') }])));
    await asUser((repo) => repo.write(async () => []));
    expect(await owner.supplementChange.count({ where: { userId } })).toBe(1);

    const silent = asUser((repo) =>
      repo.write(async (state) => {
        state.items = [];
        return [];
      }),
    );
    await expect(silent).rejects.toThrow(/without logging a change/);
    expect(await owner.supplementItem.count({ where: { userId } })).toBe(1);
  });

  it('replays the stored log to the stored stack, and finds a removed item by its id in the payload', async () => {
    const write = (changes: SupplementChangeBody[]) => asUser((repo) => repo.write(async (state) => apply(state, changes)));
    await write([{ type: 'day_types_set', dayTypes: [{ id: 'lift', name: 'Lift', sessionTime: '17:00' }] }]);
    await write([{ type: 'added', item: item('a') }]);
    await write([{ type: 'added', item: item('b', { doses: [{ slot: 'pre', amount: '', servings: 1, dayTypes: ['lift'] }] }) }]);
    await write([{ type: 'added', item: item('c') }]);
    await write([{ type: 'mix_created', mix: item('mix'), partIds: ['b', 'a'] }]);
    await write([{ type: 'removed', item: item('c', { name: 'As removed' }) }]);

    const stored = await asUser((repo) => repo.load());
    expect(stored.items.map((i) => i.id)).toEqual(['mix']);
    expect(stored.folded.map((f) => [f.item.id, f.mixId])).toEqual([
      ['b', 'mix'],
      ['a', 'mix'],
    ]);
    const log = await asUser((repo) => repo.changesThrough(TODAY));
    expect(stackAsOf(log, TODAY).stack).toEqual(stored.items);
    expect(await asUser((repo) => repo.changesThrough('2026-11-19'))).toEqual([]);

    expect(await asUser((repo) => repo.lastRemoved('c'))).toEqual(item('c', { name: 'As removed' }));
    expect(await asUser((repo) => repo.lastRemoved('a'))).toBeUndefined();
    expect(await asUser((repo) => repo.firstChangeDate())).toBe(TODAY);
    // The largest beforeSeq the API accepts is the largest the integer column holds.
    expect((await asUser((repo) => repo.changes({ beforeSeq: 2_147_483_647, limit: 10 }))).map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
