import { defaultFocusPool } from '@lifting-logbook/core';
import { FocusBlock } from '@lifting-logbook/types';
import { InMemoryFocusRepository } from '../adapters/in-memory/focus.adapter';
import { carryEditsToSuccessor } from './focus.util';

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
// treats a successor deleted since it was listed as nothing to carry (#1222).
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

  it('rethrows any other failure', async () => {
    jest.spyOn(focus, 'updateBlock').mockRejectedValue(new Error('connection lost'));
    await expect(carryEditsToSuccessor(focus, october, edited, TODAY)).rejects.toThrow('connection lost');
  });
});
