import { latestTrainingMaxFirst, validateTrainingMaxImport, type TrainingMax } from '@src/core';

const row = (lift: string, weight: number, date: string): TrainingMax =>
  ({ lift, weight, dateUpdated: new Date(`${date}T00:00:00.000Z`) }) as TrainingMax;

const collisions = (rows: TrainingMax[]) => validateTrainingMaxImport(rows).spellingCollisions;

// #1135: two rows in one file that resolve to one lift can't both apply as its max.
describe('training-max spelling collisions', () => {
  it('names both spellings of Squat and Back Squat, most recent first, with where each stores', () => {
    expect(collisions([row('Squat', 300, '2025-01-01'), row('Back Squat', 320, '2026-01-01')])).toEqual([
      {
        key: 'back-squat',
        rows: [
          { spelling: 'Back Squat', lift: 'Back Squat', weight: 320, dateUpdated: '2026-01-01' },
          { spelling: 'Squat', lift: 'back-squat', weight: 300, dateUpdated: '2025-01-01' },
        ],
      },
    ]);
  });

  it('flags OH Press and OH Press-HV, which share one stored lift', () => {
    const [collision] = collisions([row('OH Press-HV', 75, '2024-01-01'), row('OH Press', 115, '2026-01-01')]);
    expect(collision?.key).toBe('overhead-press');
    expect(collision?.rows.map((r) => [r.spelling, r.lift])).toEqual([
      ['OH Press', 'overhead-press'],
      ['OH Press-HV', 'overhead-press'],
    ]);
  });

  it('puts first the row the import stores under a shared lift, including on a same-day tie', () => {
    const rows = [row('OH Press-HV', 75, '2026-01-01'), row('OH Press', 115, '2026-01-01')];
    const { valid } = validateTrainingMaxImport(rows);
    expect(latestTrainingMaxFirst(valid)[0]?.weight).toBe(75);
    expect(collisions(rows)[0]?.rows[0]).toMatchObject({ spelling: 'OH Press-HV', weight: 75 });
  });

  it('breaks a tie by the newest row\'s place in the file, not where the spelling first appeared', () => {
    const rows = [
      row('OH Press-HV', 75, '2024-01-01'),
      row('OH Press', 115, '2026-01-01'),
      row('OH Press-HV', 80, '2026-01-01'),
    ];
    const { valid } = validateTrainingMaxImport(rows);
    expect(latestTrainingMaxFirst(valid)[0]?.weight).toBe(115);
    expect(collisions(rows)[0]?.rows.map((r) => [r.spelling, r.weight])).toEqual([
      ['OH Press', 115],
      ['OH Press-HV', 80],
    ]);
  });

  it('flags an alternative name, which stores as written', () => {
    const [collision] = collisions([row('Flat Bench Press', 200, '2025-01-01'), row('Bench Press', 210, '2025-06-01')]);
    expect(collision?.key).toBe('bench-press');
    expect(collision?.rows.map((r) => r.lift)).toEqual(['bench-press', 'Flat Bench Press']);
  });

  it('lists a spelling once, at its most recent row', () => {
    const [collision] = collisions([
      row('OH Press', 80, '2024-01-01'),
      row('OH Press', 100, '2025-01-01'),
      row('OH Press-HV', 90, '2024-06-01'),
    ]);
    expect(collision?.rows.map((r) => [r.spelling, r.weight])).toEqual([
      ['OH Press', 100],
      ['OH Press-HV', 90],
    ]);
  });

  it('finds nothing for one spelling repeated, or for different lifts', () => {
    expect(collisions([row('Squat', 300, '2025-01-01'), row('Squat', 310, '2026-01-01')])).toEqual([]);
    expect(collisions([row('Squat', 300, '2025-01-01'), row('Bench P.', 200, '2025-01-01')])).toEqual([]);
  });
});
