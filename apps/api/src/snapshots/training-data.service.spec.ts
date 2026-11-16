import { NON_CYCLE_ROW_KEY } from '../programs/macrocycle-history.util';
import { shiftNonCycleKey } from './training-data.service';

describe('shiftNonCycleKey (#1309)', () => {
  it('moves the workout number and keeps the rest, a lift name with colons included', () => {
    expect(shiftNonCycleKey(`${NON_CYCLE_ROW_KEY}1:2:20250308:Lift: Paused:1~1`, 5)).toBe(
      `${NON_CYCLE_ROW_KEY}1:7:20250308:Lift: Paused:1~1`,
    );
  });

  it('leaves a key without the non-cycle prefix as it is', () => {
    expect(shiftNonCycleKey('1:2:20250308:squat:1', 5)).toBe('1:2:20250308:squat:1');
    expect(shiftNonCycleKey('macrocycle-row:2', 5)).toBe('macrocycle-row:2');
  });
});
