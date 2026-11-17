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
      };
      const withRemoved = { ...continued, ended: null, removed };

      it('reads back as save writes it', () => {
        const macrocycles: BatchMacrocycles = { created: ['m-5'], extended: [], chosen: [], continued: withRemoved };
        expect(roundTrip(macrocycles)).toEqual(macrocycles);
        const dated = { ...removed, endDate: '2026-03-20', importedThrough: '2026-03-01', schedule: [] };
        const other: BatchMacrocycles = { ...macrocycles, continued: { ...withRemoved, removed: dated } };
        expect(roundTrip(other)).toEqual(other);
      });

      it('reads an unreadable one as a run with no id, so undo refuses', () => {
        for (const bad of [
          { ...withRemoved, removed: 'm-4' },
          { ...withRemoved, removed: { ...removed, origin: 'elsewhere' } },
          { ...withRemoved, removed: { ...removed, startDate: null } },
          { ...withRemoved, removed: { ...removed, schedule: [{ workoutNum: 1.5, weekNum: 1, scheduledDate: '2026-03-02' }] } },
          { ...withRemoved, removed: { ...removed, schedule: null } },
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
