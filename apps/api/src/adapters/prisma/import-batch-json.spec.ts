import { Weekday } from '@lifting-logbook/core';
import { Prisma } from '@prisma/client';
import { BatchMacrocycles } from '../../ports/IImportBatchRepository';
import { batchMacrocyclesJson, parseBatchMacrocycles } from './import-batch-json';

describe('parseBatchMacrocycles (#1255)', () => {
  it('reads the column as save writes it', () => {
    const macrocycles: BatchMacrocycles = {
      created: ['m-1', 'm-2'],
      extended: ['m-3'],
      chosen: [
        { id: 'm-1', chose: 'completed', before: { statusChosen: false } },
        { id: 'm-3', chose: 'abandoned', before: { status: 'in-progress', statusChosen: false } },
      ],
    };
    // Read back as Postgres returns it: through JSON.
    const column: Prisma.JsonValue = JSON.parse(JSON.stringify(batchMacrocyclesJson(macrocycles)));
    expect(parseBatchMacrocycles(column)).toEqual(macrocycles);
  });

  it('reads a batch without the column as null', () => {
    expect(parseBatchMacrocycles(null)).toBeNull();
  });

  it('reads an unreadable column as null, and drops only the unreadable parts of a readable one', () => {
    expect(parseBatchMacrocycles(['m-1'])).toBeNull();
    expect(parseBatchMacrocycles('m-1')).toBeNull();
    expect(
      parseBatchMacrocycles({
        created: ['m-1', 7, null],
        extended: ['m-2', { id: 'm-4' }],
        chosen: [
          'm-2',
          { id: 'm-2', chose: 'retired', before: { statusChosen: false } },
          { id: 'm-2', chose: 'overran', before: { status: 'in-progress', statusChosen: 'yes' } },
          { id: 'm-2', chose: 'overran', before: null },
          { id: 'm-2', chose: 'overran', before: { status: 'retired', statusChosen: true } },
        ],
      }),
    ).toEqual({ created: ['m-1'], extended: ['m-2'], chosen: [{ id: 'm-2', chose: 'overran', before: { statusChosen: true } }] });
    expect(parseBatchMacrocycles({ created: 'm-1' })).toEqual({ created: [], extended: [], chosen: [] });
  });

  describe('a continued run (#1180)', () => {
    const continued = {
      id: 'm-5',
      ended: { id: 'm-4', endDate: null, status: 'in-progress' as const },
      dashboard: {
        macrocycleUnit: 'week',
        macrocycleDate: '2026-03-02T00:00:00.000Z',
        sheetName: '5-3-1_Cycle_4_20260302',
        macrocycleStartWeekday: Weekday.Monday,
        programType: null,
      },
      activeProgram: '5-3-1',
    };
    const roundTrip = (macrocycles: BatchMacrocycles) =>
      parseBatchMacrocycles(JSON.parse(JSON.stringify(batchMacrocyclesJson(macrocycles))) as Prisma.JsonValue);

    it('reads back as save writes it', () => {
      const macrocycles: BatchMacrocycles = { created: ['m-5'], extended: [], chosen: [], continued };
      expect(roundTrip(macrocycles)).toEqual(macrocycles);
      const nothingEnded: BatchMacrocycles = { ...macrocycles, continued: { ...continued, ended: null, dashboard: null, activeProgram: null } };
      expect(roundTrip(nothingEnded)).toEqual(nothingEnded);
    });

    it('reads an unreadable one as a run with no id, so undo refuses', () => {
      for (const bad of [
        'm-5',
        { ...continued, id: 5 },
        { ...continued, ended: { id: 'm-4' } },
        { ...continued, dashboard: { sheetName: 1 } },
        { ...continued, dashboard: { ...continued.dashboard, macrocycleStartWeekday: 'Someday' } },
      ]) {
        expect(parseBatchMacrocycles({ created: [], extended: [], chosen: [], continued: bad })?.continued?.id).toBe('');
      }
    });

    describe('with the empty live macrocycle it removed (#1354)', () => {
      const removed = {
        id: 'm-4',
        startDate: '2026-03-02',
        endDate: null,
        status: 'in-progress' as const,
        statusChosen: false,
        origin: 'live' as const,
        unmatched: false,
        importedThrough: null,
        schedule: [{ workoutNum: 1, weekNum: 1, scheduledDate: '2026-03-02T00:00:00.000Z' }],
        dateOverrides: [],
        skips: [],
        liftOverrides: [],
        focus: [],
      };
      const withRemoved = { ...continued, ended: null, removed };
      // Its workouts' overrides and focus day state (#1359).
      const focusState = {
        modes: { b1: 'pick' as const },
        picks: { b1: ['Hammer Curl'] },
        trims: { b2: ['Seated Calf Raise'] },
        placement: 'interleave' as const,
        order: ['Squat', 'Hammer Curl'],
        dismissed: true,
      };
      const withRows = {
        ...removed,
        dateOverrides: [{ workoutNum: 1, newDate: '2026-03-04T00:00:00.000Z' }],
        skips: [
          { workoutNum: 2, reason: 'travelling' },
          { workoutNum: 4, reason: null },
        ],
        liftOverrides: [
          {
            workoutNum: 3,
            overrides: [
              { lift: 'Deadlift', action: 'replace' as const, replacedBy: 'Trap Bar Deadlift' },
              { lift: 'Face Pull', action: 'add' as const },
            ],
          },
        ],
        focus: [{ workoutNum: 3, state: focusState }],
      };

      it('reads back as save writes it', () => {
        const macrocycles: BatchMacrocycles = { created: ['m-5'], extended: [], chosen: [], continued: withRemoved };
        expect(roundTrip(macrocycles)).toEqual(macrocycles);
        const dated = { ...removed, endDate: '2026-03-20', importedThrough: '2026-03-01', schedule: [] };
        const other: BatchMacrocycles = { ...macrocycles, continued: { ...withRemoved, removed: dated } };
        expect(roundTrip(other)).toEqual(other);
      });

      it('reads back its overrides and focus day state as save writes them (#1359)', () => {
        const macrocycles: BatchMacrocycles = { created: ['m-5'], extended: [], chosen: [], continued: { ...withRemoved, removed: withRows } };
        expect(roundTrip(macrocycles)).toEqual(macrocycles);
      });

      it('reads one from before #1359 as having no overrides or focus day state', () => {
        const { dateOverrides: _d, skips: _s, liftOverrides: _l, focus: _f, ...old } = removed;
        expect(parseBatchMacrocycles({ created: [], extended: [], chosen: [], continued: { ...withRemoved, removed: old } })?.continued).toEqual(
          withRemoved,
        );
      });

      it('reads an unreadable one as a run with no id, so undo refuses', () => {
        for (const bad of [
          { ...withRemoved, removed: 'm-4' },
          { ...withRemoved, removed: { ...removed, origin: 'elsewhere' } },
          { ...withRemoved, removed: { ...removed, startDate: null } },
          { ...withRemoved, removed: { ...removed, schedule: [{ workoutNum: 1.5, weekNum: 1, scheduledDate: '2026-03-02' }] } },
          { ...withRemoved, removed: { ...removed, schedule: null } },
          // An unreadable override or focus day state (#1359).
          { ...withRemoved, removed: { ...withRows, dateOverrides: null } },
          { ...withRemoved, removed: { ...withRows, dateOverrides: [{ workoutNum: 1, newDate: 4 }] } },
          { ...withRemoved, removed: { ...withRows, skips: [{ workoutNum: '2', reason: null }] } },
          { ...withRemoved, removed: { ...withRows, skips: [{ workoutNum: 2 }] } },
          { ...withRemoved, removed: { ...withRows, liftOverrides: [{ workoutNum: 3, overrides: [{ lift: 'Deadlift', action: 'swap' }] }] } },
          { ...withRemoved, removed: { ...withRows, liftOverrides: [{ workoutNum: 3, overrides: [{ lift: 'Deadlift', action: 'replace', replacedBy: 7 }] }] } },
          { ...withRemoved, removed: { ...withRows, liftOverrides: [{ workoutNum: 3 }] } },
          { ...withRemoved, removed: { ...withRows, focus: [{ workoutNum: 3 }] } },
          { ...withRemoved, removed: { ...withRows, focus: [{ workoutNum: 3, state: { ...focusState, placement: 'sideways' } }] } },
          { ...withRemoved, removed: { ...withRows, focus: [{ workoutNum: 3, state: { ...focusState, modes: { b1: 'sometimes' } } }] } },
          { ...withRemoved, removed: { ...withRows, focus: [{ workoutNum: 3, state: { ...focusState, picks: { b1: [1] } } }] } },
          { ...withRemoved, removed: { ...withRows, focus: [{ workoutNum: 3, state: { ...focusState, trims: ['x'] } }] } },
          { ...withRemoved, removed: { ...withRows, focus: [{ workoutNum: 3, state: { ...focusState, order: 'Squat' } }] } },
          { ...withRemoved, removed: { ...withRows, focus: [{ workoutNum: 3, state: { ...focusState, dismissed: 'yes' } }] } },
        ]) {
          expect(parseBatchMacrocycles({ created: [], extended: [], chosen: [], continued: bad })?.continued?.id).toBe('');
        }
      });
    });
  });

  describe('an overwrite (#1182)', () => {
    it('reads back as save writes it', () => {
      const macrocycles: BatchMacrocycles = { created: ['m-1'], extended: [], chosen: [], overwrite: { snapshotId: 's-1' } };
      expect(parseBatchMacrocycles(batchMacrocyclesJson(macrocycles) as Prisma.JsonValue)).toEqual(macrocycles);
    });

    it('reads an unreadable one as naming no snapshot, so undo refuses it', () => {
      for (const bad of [null, 's-1', {}, { snapshotId: 7 }]) {
        expect(parseBatchMacrocycles({ created: [], extended: [], chosen: [], overwrite: bad })?.overwrite).toEqual({ snapshotId: '' });
      }
    });
  });
});
