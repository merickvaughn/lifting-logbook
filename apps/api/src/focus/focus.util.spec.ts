import { LiftRecord, defaultFocusPool, defaultPoolEntry } from '@lifting-logbook/core';
import { FocusBlock } from '@lifting-logbook/types';
import { InMemoryCustomLiftRepository } from '../adapters/in-memory/custom-lift.adapter';
import { InMemoryFocusRepository } from '../adapters/in-memory/focus.adapter';
import { InMemoryLiftRecordRepository } from '../adapters/in-memory/lift-record.adapter';
import { carryEditsToSuccessor, recordFocusSessions } from './focus.util';

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

// Pairs the success path with the catch in carryEditsToSuccessor (focus.util.ts), which
// treats a successor deleted since it was read as nothing to carry (#1222, #1230).
describe('carryEditsToSuccessor', () => {
  const edited: FocusBlock = { ...october, progression: 'percent_wave' };
  let focus: InMemoryFocusRepository;

  beforeEach(async () => {
    focus = new InMemoryFocusRepository();
    await focus.createBlock(october);
    await focus.createBlock(november);
  });

  it('updates the queued successor with the followed field', async () => {
    await carryEditsToSuccessor(focus, october, edited, TODAY);
    expect((await focus.getBlock('november'))?.progression).toBe('percent_wave');
  });

  it('carries nothing, without failing, when the successor was deleted after it was listed', async () => {
    const listed = await focus.listBlocks();
    await focus.deleteBlock('november');
    jest.spyOn(focus, 'listBlocks').mockResolvedValue(listed);
    await expect(carryEditsToSuccessor(focus, october, edited, TODAY)).resolves.toBeUndefined();
    expect(await focus.getBlock('november')).toBeNull();
  });

  it('carries nothing, without failing, when the successor is deleted after its lock, as with no transaction', async () => {
    const locked = await focus.lockBlocks(['november']);
    await focus.deleteBlock('november');
    jest.spyOn(focus, 'lockBlocks').mockResolvedValue(locked);
    await expect(carryEditsToSuccessor(focus, october, edited, TODAY)).resolves.toBeUndefined();
    expect(await focus.getBlock('november')).toBeNull();
  });

  // #1230: the successor edit saved since the list was read is what the carry compares against.
  it('computes the carry from the successor as locked, not as listed', async () => {
    const listed = await focus.listBlocks();
    await focus.updateBlock('november', { overlap: 'skip' });
    jest.spyOn(focus, 'listBlocks').mockResolvedValue(listed);
    await carryEditsToSuccessor(focus, october, { ...october, overlap: 'swap' }, TODAY);
    expect((await focus.getBlock('november'))?.overlap).toBe('skip');
  });

  it('rethrows any other failure', async () => {
    jest.spyOn(focus, 'updateBlock').mockRejectedValue(new Error('connection lost'));
    await expect(carryEditsToSuccessor(focus, october, edited, TODAY)).rejects.toThrow('connection lost');
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
