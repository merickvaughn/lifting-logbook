import { parseProgressionDraft, progressionDraft } from '../progression';

describe('parseProgressionDraft (#1210)', () => {
  it('clears every field when no type is chosen, whatever the inputs hold', () => {
    expect(parseProgressionDraft({ type: '', increment: '5', repsLow: '9', repsHigh: '3' })).toEqual({
      values: { type: null, increment: null, repsLow: null, repsHigh: null },
    });
  });

  it('reads blank inputs as unset and numbers as numbers', () => {
    expect(parseProgressionDraft(progressionDraft({ type: 'linear', repsHigh: 5 }))).toEqual({
      values: { type: 'linear', increment: null, repsLow: null, repsHigh: 5 },
    });
    expect(parseProgressionDraft({ type: 'double', increment: '2.5', repsLow: '8', repsHigh: '12' })).toEqual({
      values: { type: 'double', increment: 2.5, repsLow: 8, repsHigh: 12 },
    });
  });

  it.each([
    ['a zero increment', { increment: '0' }, 'Increment'],
    ['a negative increment', { increment: '-2.5' }, 'Increment'],
    ['fractional reps', { repsLow: '8.5' }, 'whole numbers'],
    ['reps above the limit', { repsHigh: '51' }, 'whole numbers'],
    ['a bottom above the top', { repsLow: '12', repsHigh: '8' }, 'bottom of the rep range'],
  ])('rejects %s', (_name, fields, message) => {
    const result = parseProgressionDraft({ type: 'double', increment: '', repsLow: '', repsHigh: '', ...fields });
    expect(result).toEqual({ error: expect.stringContaining(message) });
  });
});
