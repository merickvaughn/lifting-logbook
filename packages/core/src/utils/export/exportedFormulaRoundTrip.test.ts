import { parseCsvText, parseLiftingProgramSpec, parseStrengthGoals, parseTrainingMaxes } from '../parser';
import { serializeProgramSpec, serializeStrengthGoals, serializeTrainingMaxes } from './serializeExportCsv';

// #1342: the export escapes a formula-looking name; each parser must give it back as written.
const NAMES = [
  ...['=', '+', '-', '@', '\t', '\r', '\n'].map((c) => `${c}Curl`),
  "'=Curl",
  "'tis",
  'Bench Press',
];

describe.each(NAMES)('round trip of lift %j', (lift) => {
  it('training maxes', () => {
    const d = new Date('2026-01-05T00:00:00Z');
    const out = parseTrainingMaxes(parseCsvText(serializeTrainingMaxes([{ dateUpdated: d, lift, weight: 100 }])));
    expect(out.map((m) => m.lift)).toEqual([lift]);
  });

  it('strength goals', () => {
    const goals = [{ lift, goalType: 'absolute', target: 200, unit: 'lbs' }];
    const out = parseStrengthGoals(parseCsvText(serializeStrengthGoals(goals, new Date('2026-01-05T00:00:00Z'))));
    expect(out.map((g) => g.lift)).toEqual([lift]);
  });

  it('program specs', () => {
    const row = {
      week: 1, offset: 0, lift, increment: 5, order: 1, sets: 3, reps: 5, amrap: false,
      warmUpPct: lift, wtDecrementPct: 0, activation: lift, weekType: lift,
    };
    const [out] = parseLiftingProgramSpec(parseCsvText(serializeProgramSpec([row])));
    expect([out?.lift, out?.warmUpPct, out?.activation, out?.weekType]).toEqual([lift, lift, lift, lift]);
  });
});
