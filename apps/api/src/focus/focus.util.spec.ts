import { LiftRecord, defaultFocusPool, defaultPoolEntry } from '@lifting-logbook/core';
import { FocusBlock } from '@lifting-logbook/types';
import { InMemoryCustomLiftRepository } from '../adapters/in-memory/custom-lift.adapter';
import { InMemoryFocusRepository } from '../adapters/in-memory/focus.adapter';
import { InMemoryLiftRecordRepository } from '../adapters/in-memory/lift-record.adapter';
import { FocusBlockConflictError, FocusBlockNotFoundError } from '../ports/errors';
import { recordFocusSessions, saveBlockEdit } from './focus.util';

const TODAY = '2026-10-25';

const october: FocusBlock = {
  id: 'october',
  series: 'series',
  area: 'Biceps',
  period: 'monthly',
  align: 'calendar',
  start: '2026-10-01',
  selection: 'rules',
  overlap: 'reduce',
  progression: 'double',
  priority: 1,
  timer: { prep: 10, set: 40, rest: 45 },
  onEnd: 'autoroll',
  nextArea: 'Triceps',
  pool: defaultFocusPool('Biceps'),
};
const november: FocusBlock = {
  ...october,
  id: 'november',
  priority: 2,
  area: 'Triceps',
  start: '2026-11-01',
  onEnd: 'prompt',
  nextArea: null,
  pool: defaultFocusPool('Triceps'),
};

/** A block as created and never updated since: version 1 (ADR-039, Amendment 7). */
const unchanged = (b: FocusBlock) => ({ ...b, version: 1 });

// Pairs the success path with the catch in saveBlockEdit (focus.util.ts), which
// treats a successor deleted since it was read as nothing to carry (#1222, #1230).
describe('saveBlockEdit', () => {
  let focus: InMemoryFocusRepository;
  const block = async (id: string) => focus.getBlock(id);

  beforeEach(async () => {
    focus = new InMemoryFocusRepository();
    await focus.createBlock(october);
    await focus.createBlock(november);
  });

  it('saves the edit and updates the queued successor with the followed field', async () => {
    const saved = await saveBlockEdit(focus, 'october', { progression: 'percent_wave' }, TODAY);
    expect(saved.progression).toBe('percent_wave');
    expect((await block('november'))?.progression).toBe('percent_wave');
  });

  it("throws FocusBlockNotFoundError for a block the user doesn't have", async () => {
    await expect(saveBlockEdit(focus, 'nope', { overlap: 'skip' }, TODAY)).rejects.toBeInstanceOf(FocusBlockNotFoundError);
  });

  it('carries nothing, without failing, when the successor was deleted after it was listed', async () => {
    const listed = await focus.listBlocks();
    await focus.deleteBlock('november');
    jest.spyOn(focus, 'listBlocks').mockResolvedValue(listed);
    await expect(saveBlockEdit(focus, 'october', { progression: 'percent_wave' }, TODAY)).resolves.toMatchObject({
      progression: 'percent_wave',
    });
    expect(await block('november')).toBeNull();
  });

  it('carries nothing, without failing, when the successor is deleted after its lock, as with no transaction', async () => {
    const locked = new Map((await focus.lockBlocks(['october', 'november'])).map((b) => [b.id, b] as const));
    await focus.deleteBlock('november');
    jest.spyOn(focus, 'listBlocks').mockResolvedValue([...locked.values()]);
    jest.spyOn(focus, 'lockBlocks').mockImplementation(async (ids) => ids.flatMap((id) => locked.get(id) ?? []));
    await expect(saveBlockEdit(focus, 'october', { progression: 'percent_wave' }, TODAY)).resolves.toMatchObject({
      progression: 'percent_wave',
    });
    expect(await block('november')).toBeNull();
  });

  // #1230: the successor edit saved since the list was read is what the carry compares against.
  it('computes the carry from the successor as locked, not as listed', async () => {
    const listed = await focus.listBlocks();
    await focus.updateBlock('november', { overlap: 'skip' });
    jest.spyOn(focus, 'listBlocks').mockResolvedValue(listed);
    await saveBlockEdit(focus, 'october', { overlap: 'swap' }, TODAY);
    expect((await block('november'))?.overlap).toBe('skip');
  });

  it("rethrows any other failure of the successor's update", async () => {
    const update = focus.updateBlock.bind(focus);
    jest
      .spyOn(focus, 'updateBlock')
      .mockImplementation((id, patch) => (id === 'november' ? Promise.reject(new Error('connection lost')) : update(id, patch)));
    await expect(saveBlockEdit(focus, 'october', { progression: 'percent_wave' }, TODAY)).rejects.toThrow('connection lost');
  });

  // ADR-039, Amendment 6 (#1226): a date edit moves the queued successor.
  describe('a date edit', () => {
    it('moves the successor to start after the lengthened block, taking its new period', async () => {
      await saveBlockEdit(focus, 'october', { period: 'quarterly' }, TODAY);
      expect(await block('november')).toMatchObject({ start: '2027-01-01', period: 'quarterly', align: 'calendar' });
    });

    it('moves the successor earlier when the block is shortened, closing the gap', async () => {
      await focus.updateBlock('october', { period: 'quarterly' });
      await focus.updateBlock('november', { start: '2027-01-01', period: 'quarterly' });
      await saveBlockEdit(focus, 'october', { period: 'monthly' }, TODAY);
      expect(await block('november')).toMatchObject({ start: '2026-11-01', period: 'monthly' });
    });

    it('keeps an align the lifter set on the successor, and still moves it', async () => {
      await focus.updateBlock('november', { align: 'custom' });
      await saveBlockEdit(focus, 'october', { period: 'quarterly' }, TODAY);
      expect(await block('november')).toMatchObject({ start: '2027-01-01', period: 'quarterly', align: 'custom' });
    });

    it('takes a new custom start and align, moving to the day after the new range', async () => {
      await saveBlockEdit(focus, 'october', { align: 'custom', start: '2026-10-10' }, TODAY);
      expect(await block('november')).toMatchObject({ start: '2026-11-10', period: 'monthly', align: 'custom' });
    });

    it("moves the successor first when the block's new start is the successor's old one", async () => {
      await saveBlockEdit(focus, 'october', { align: 'custom', start: '2026-11-01' }, TODAY);
      expect(await block('october')).toMatchObject({ start: '2026-11-01', align: 'custom' });
      expect(await block('november')).toMatchObject({ start: '2026-12-01', align: 'custom' });
    });

    it('leaves the successor alone when the range end is unchanged', async () => {
      await saveBlockEdit(focus, 'october', { align: 'custom', start: '2026-10-01' }, TODAY);
      expect(await block('november')).toMatchObject({ start: '2026-11-01', align: 'custom' });
    });

    it('refuses a move onto a start another block in the series holds, saving nothing', async () => {
      const january = { ...november, id: 'january', start: '2027-01-01', priority: 3 };
      await focus.createBlock(january);
      const error = await saveBlockEdit(focus, 'october', { period: 'quarterly' }, TODAY).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FocusBlockConflictError);
      expect(error).toMatchObject({ series: 'series', start: '2027-01-01' });
      expect(await block('october')).toEqual(unchanged(october));
      expect(await block('november')).toEqual(unchanged(november));
      expect(await block('january')).toEqual(unchanged(january));
    });

    it('moves a follow-on queued inside the new range to start after it, copying no settings', async () => {
      await focus.updateBlock('november', { start: '2026-11-15', align: 'custom' });
      await saveBlockEdit(focus, 'october', { period: 'quarterly' }, TODAY);
      expect(await block('november')).toMatchObject({ start: '2027-01-01', period: 'monthly', align: 'custom' });
    });

    it('refuses a lengthening that would overlap a block queued after the successor, saving nothing', async () => {
      const december = { ...november, id: 'december', start: '2026-12-01', priority: 3 };
      await focus.createBlock(december);
      const error = await saveBlockEdit(focus, 'october', { period: 'quarterly' }, TODAY).catch((e: unknown) => e);
      expect(error).toMatchObject({ series: 'series', start: '2026-12-01' });
      expect(await block('october')).toEqual(unchanged(october));
      expect(await block('november')).toEqual(unchanged(november));
    });

    // The block is written first here, so only the check before both writes keeps it unchanged.
    it('refuses a successor moving earlier onto a taken start before the block is written', async () => {
      await focus.updateBlock('october', { period: 'quarterly' });
      await focus.updateBlock('november', { start: '2027-01-01', period: 'quarterly' });
      await focus.createBlock({ ...november, id: 'extra', start: '2026-11-01', priority: 3 });
      const error = await saveBlockEdit(focus, 'october', { period: 'monthly' }, TODAY).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FocusBlockConflictError);
      expect(await block('october')).toMatchObject({ period: 'quarterly' });
      expect(await block('november')).toMatchObject({ start: '2027-01-01' });
    });

    it('saves the block when the successor moving later was deleted after its lock', async () => {
      const locked = new Map((await focus.lockBlocks(['october', 'november'])).map((b) => [b.id, b] as const));
      await focus.deleteBlock('november');
      jest.spyOn(focus, 'listBlocks').mockResolvedValue([...locked.values()]);
      jest.spyOn(focus, 'lockBlocks').mockImplementation(async (ids) => ids.flatMap((id) => locked.get(id) ?? []));
      await expect(saveBlockEdit(focus, 'october', { period: 'quarterly' }, TODAY)).resolves.toMatchObject({ period: 'quarterly' });
      expect(await block('october')).toMatchObject({ period: 'quarterly' });
    });
  });
});

describe('recordFocusSessions', () => {
  const cable = defaultPoolEntry('Cable Curl');
  const hammer = { ...defaultPoolEntry('Hammer Curl'), weight: 20 };
  const curls: FocusBlock = { ...october, id: 'curls', series: 'curls', onEnd: 'prompt', nextArea: null, pool: [cable, hammer] };
  const set = (setNum: number): LiftRecord => ({
    program: '5-3-1',
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2026-10-20T00:00:00.000Z'),
    lift: 'Cable Curl',
    setNum,
    weight: 25,
    reps: 12,
    notes: '',
  });
  const recorded = { ...cable, weight: 25, lastReps: [12, 12], lastDate: '2026-10-20' };
  let focus: InMemoryFocusRepository;
  let repos: Parameters<typeof recordFocusSessions>[0];

  beforeEach(async () => {
    focus = new InMemoryFocusRepository();
    await focus.createBlock(curls);
    repos = {
      focus,
      liftRecord: new InMemoryLiftRecordRepository(new Map([['5-3-1', [set(1), set(2)]]])),
      customLift: new InMemoryCustomLiftRepository('u'),
    };
  });

  it('records the last session on the stored block', async () => {
    const [block] = await recordFocusSessions(repos, await focus.listBlocks(), TODAY);
    expect(block?.pool).toEqual([recorded, hammer]);
    expect((await focus.getBlock('curls'))?.pool).toEqual([recorded, hammer]);
  });

  // #1230: a setup edit saved after the plan read the blocks is kept, not overwritten.
  it('records into the block as locked, keeping an edit saved since the blocks were read', async () => {
    const read = await focus.listBlocks();
    await focus.updateBlock('curls', { pool: [cable, { ...hammer, weight: 30 }] });
    const [block] = await recordFocusSessions(repos, read, TODAY);
    expect((await focus.getBlock('curls'))?.pool).toEqual([recorded, { ...hammer, weight: 30 }]);
    expect(block?.pool).toEqual([recorded, { ...hammer, weight: 30 }]);
  });

  it('writes nothing to a block that stopped being double since it was read', async () => {
    const read = await focus.listBlocks();
    await focus.updateBlock('curls', { progression: 'manual' });
    const [block] = await recordFocusSessions(repos, read, TODAY);
    expect((await focus.getBlock('curls'))?.pool).toEqual([cable, hammer]);
    expect(block?.progression).toBe('manual');
  });
});
