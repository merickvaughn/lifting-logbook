import type { TrainingMaxHistoryEntryResponse } from '@lifting-logbook/types';
import { buildTmAtTimeIndex } from '@/lib/tmAtTime';

function entry(
  lift: string,
  date: string,
  weight: number,
  id = `${lift}-${date}-${weight}`,
): TrainingMaxHistoryEntryResponse {
  return { id, lift, weight, unit: 'lbs', date, isPR: false, source: 'program', goalMet: false };
}

/** The inline form the helper replaced, kept verbatim as the differential oracle. */
function original(
  lift: string,
  date: string,
  entries: TrainingMaxHistoryEntryResponse[],
): TrainingMaxHistoryEntryResponse | null {
  return (
    entries
      .filter((e) => e.lift === lift && e.date <= date)
      .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null
  );
}

describe('buildTmAtTimeIndex', () => {
  const entries = [
    entry('Squat', '2026-01-01', 300),
    entry('Squat', '2026-03-01', 315),
    entry('Bench Press', '2026-02-01', 200),
    entry('Squat', '2026-02-01', 310),
  ];
  const index = buildTmAtTimeIndex(entries);

  it('returns the latest entry dated on or before the record', () => {
    expect(index.find('Squat', '2026-02-15')?.weight).toBe(310);
    expect(index.find('Squat', '2026-03-01')?.weight).toBe(315);
    expect(index.find('Squat', '2026-12-31')?.weight).toBe(315);
  });

  it('excludes entries dated after the record', () => {
    expect(index.find('Squat', '2026-01-15')?.weight).toBe(300);
  });

  it('returns null when nothing is in force yet, or the lift has no history', () => {
    expect(index.find('Squat', '2025-12-31')).toBeNull();
    expect(index.find('Deadlift', '2026-06-01')).toBeNull();
  });

  it('keeps lifts apart', () => {
    expect(index.find('Bench Press', '2026-06-01')?.weight).toBe(200);
  });

  it('breaks an equal-date tie the way the original did: first in API order wins', () => {
    // Two Squat entries on the same date, in the order the API returned them.
    // Stable sort keeps that order, so the first one is the answer — regardless
    // of weight. (Deterministic API-side ordering is #908's job.)
    const tied = buildTmAtTimeIndex([
      entry('Squat', '2026-01-01', 300, 'a'),
      entry('Squat', '2026-01-01', 305, 'b'),
    ]);
    expect(tied.find('Squat', '2026-01-01')?.id).toBe('a');
    expect(tied.find('Squat', '2026-02-01')?.id).toBe('a');
  });

  it('matches the original filter/sort form for every (lift, date) over an enumerated history', () => {
    const lifts = ['Squat', 'Bench Press', 'Deadlift'];
    const dates = ['2026-01-01', '2026-01-15', '2026-02-01', '2026-02-01', '2026-03-10'];
    // Every lift on every date, with a duplicated date per lift, in a shuffled
    // API order so the tie-break and the grouping both get exercised.
    const history: TrainingMaxHistoryEntryResponse[] = [];
    let weight = 100;
    for (const date of dates) {
      for (const lift of lifts) {
        history.push(entry(lift, date, (weight += 5), `${lift}-${date}-${weight}`));
      }
    }
    history.reverse();

    const differential = buildTmAtTimeIndex(history);
    const probes = ['2025-12-31', ...dates, '2026-02-15', '2027-01-01'];
    for (const lift of [...lifts, 'Overhead Press']) {
      for (const date of probes) {
        expect(differential.find(lift, date)).toEqual(original(lift, date, history));
      }
    }
  });
});
