import { FocusDayState } from '@lifting-logbook/types';
import { InMemoryFocusRepository } from './focus.adapter';

const STATE: FocusDayState = { modes: {}, picks: {}, trims: {}, placement: 'after', order: null, dismissed: true };

describe('InMemoryFocusRepository', () => {
  it('deletes every day state of a program across macrocycles, leaving other programs alone (#1084)', async () => {
    const repo = new InMemoryFocusRepository();
    await repo.saveDayState('5-3-1', 1, 1, STATE);
    await repo.saveDayState('5-3-1', 2, 4, STATE);
    await repo.saveDayState('leangains', 1, 1, STATE);

    await repo.deleteAllDayStates('5-3-1');

    expect(await repo.getDayState('5-3-1', 1, 1)).toBeNull();
    expect(await repo.getDayState('5-3-1', 2, 4)).toBeNull();
    expect(await repo.getDayState('leangains', 1, 1)).toEqual(STATE);
  });
});
