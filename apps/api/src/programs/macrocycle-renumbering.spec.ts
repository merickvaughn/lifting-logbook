import { Logger } from '@nestjs/common';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { LiftRecord } from '@lifting-logbook/core';
import { ImportBatchRecord } from '../ports/IImportBatchRepository';
import { InMemoryImportBatchRepository } from '../adapters/in-memory/import-batch.adapter';
import { InMemoryLiftRecordRepository } from '../adapters/in-memory/lift-record.adapter';
import { InMemoryMacrocycleRepository, macrocycleRowFixture } from '../adapters/in-memory/macrocycle.adapter';
import { InMemoryWorkoutSkipOverrideRepository } from '../adapters/in-memory/workout-skip-override.adapter';
import { MacrocycleNumberConflictError } from '../ports/errors';
import {
  RENUMBERING_SETTING,
  renumberingChanges,
  renumberingEnabled,
  renumberPreImageKeys,
  renumberProgram,
} from './macrocycle-renumbering';

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();

const PROGRAM = '5-3-1';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('renumberingChanges', () => {
  it('moves nothing when the numbers already run 1 to N', () => {
    expect(renumberingChanges([{ macrocycleNum: 1 }, { macrocycleNum: 2 }, { macrocycleNum: 3 }])).toEqual(new Map());
  });

  it('maps each number to its place in the order it was given', () => {
    // An older macrocycle stored past the others sorts first, as `list` returns it.
    expect(renumberingChanges([{ macrocycleNum: 3 }, { macrocycleNum: 1 }, { macrocycleNum: 2 }])).toEqual(
      new Map([[3, 1], [1, 2], [2, 3]]),
    );
  });

  it('closes a gap without moving the numbers before it', () => {
    expect(renumberingChanges([{ macrocycleNum: 1 }, { macrocycleNum: 3 }])).toEqual(new Map([[3, 2]]));
  });
});

describe('renumberPreImageKeys', () => {
  const set = { kind: 'created' as const, wrote: { weight: 200, reps: 5, notes: '' } };

  it('moves current, date-blind and legacy-row keys, and leaves keys whose number stays', () => {
    const moved = renumberPreImageKeys(
      {
        '2:1:20250303:Squat:1': set,
        '2:1:Squat:1': set,
        'macrocycle-row:2': { kind: 'created', wrote: { macrocycleNum: 2 } },
        '1:1:20260105:Squat:1': set,
      },
      new Map([[2, 3]]),
    );

    expect(moved).toEqual({
      '3:1:20250303:Squat:1': set,
      '3:1:Squat:1': set,
      'macrocycle-row:3': { kind: 'created', wrote: { macrocycleNum: 3 } },
      '1:1:20260105:Squat:1': set,
    });
  });

  it('matches the whole number, not a prefix of it', () => {
    expect(renumberPreImageKeys({ '12:1:20250303:Squat:1': set }, new Map([[1, 2]]))).toBeNull();
  });

  it('returns null when no key moves', () => {
    expect(renumberPreImageKeys({ '1:1:20250303:Squat:1': set }, new Map([[2, 3]]))).toBeNull();
  });
});

describe('renumberProgram', () => {
  const previous = process.env[RENUMBERING_SETTING];
  afterEach(() => {
    if (previous === undefined) delete process.env[RENUMBERING_SETTING];
    else process.env[RENUMBERING_SETTING] = previous;
    exporter.reset();
  });

  const record = (macrocycleNum: number, date: string): LiftRecord => ({
    program: PROGRAM,
    macrocycleNum,
    workoutNum: 1,
    date: day(date),
    lift: 'Squat',
    setNum: 1,
    weight: 200,
    reps: 5,
    notes: '',
  });

  /** A live macrocycle 1 from 2026 and a legacy one numbered 2 from 2025, with a set and a batch for the legacy one. */
  const outOfOrder = async () => {
    const liftRecord = new InMemoryLiftRecordRepository(new Map());
    await liftRecord.appendLiftRecords(PROGRAM, [record(1, '2026-01-05'), record(2, '2025-03-03')]);
    const macrocycle = new InMemoryMacrocycleRepository([
      macrocycleRowFixture(1, { startDate: day('2026-01-05') }),
      macrocycleRowFixture(2, { startDate: day('2025-03-03'), origin: 'legacy', status: 'unknown' }),
    ]);
    macrocycle.attachNumbered([liftRecord]);
    const importBatch = new InMemoryImportBatchRepository();
    const batch: ImportBatchRecord = {
      id: 'batch-1',
      userId: 'u',
      program: PROGRAM,
      destination: 'lift-records',
      preImage: {
        '2:1:20250303:Squat:1': { kind: 'created', wrote: { weight: 200, reps: 5, notes: '' } },
        'macrocycle-row:2': { kind: 'created', wrote: { macrocycleNum: 2 } },
      },
      createdAt: day('2026-11-01'),
    };
    await importBatch.save(batch);
    return { liftRecord, macrocycle, importBatch };
  };

  const numbersByStart = async (repos: Awaited<ReturnType<typeof outOfOrder>>) =>
    (await repos.macrocycle.list(PROGRAM)).map((m) => [m.startDate.toISOString().slice(0, 10), m.macrocycleNum]);

  it('rewrites nothing while the setting is off', async () => {
    delete process.env[RENUMBERING_SETTING];
    const repos = await outOfOrder();

    expect(await renumberProgram(repos, PROGRAM)).toEqual(new Map());

    expect(await numbersByStart(repos)).toEqual([['2025-03-03', 2], ['2026-01-05', 1]]);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('treats a setting other than "on" as off, with a warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      process.env[RENUMBERING_SETTING] = 'ON';
      expect(renumberingEnabled()).toBe(false);
      expect(renumberingEnabled()).toBe(false);
      // Once per value, not on every call.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('"ON"');
    } finally {
      warn.mockRestore();
    }
  });

  it('numbers by start date in every store and batch, recording what it moved on a span', async () => {
    process.env[RENUMBERING_SETTING] = 'on';
    const repos = await outOfOrder();
    // A batch with no key on a moving number is left as it is.
    await repos.importBatch.save({
      id: 'batch-other',
      userId: 'u',
      program: PROGRAM,
      destination: 'lift-records',
      preImage: { '7:1:20240101:Squat:1': { kind: 'created', wrote: { weight: 1, reps: 1, notes: '' } } },
      createdAt: day('2026-11-01'),
    });
    const update = jest.spyOn(repos.importBatch, 'updatePreImages');

    expect(await renumberProgram(repos, PROGRAM)).toEqual(new Map([[2, 1], [1, 2]]));
    expect(update.mock.calls.map(([updates]) => updates.map((u) => u.id))).toEqual([['batch-1']]);

    expect(await numbersByStart(repos)).toEqual([['2025-03-03', 1], ['2026-01-05', 2]]);
    expect((await repos.liftRecord.getLiftRecords(PROGRAM, 1)).map((r) => r.date)).toEqual([day('2025-03-03')]);
    expect((await repos.liftRecord.getLiftRecords(PROGRAM, 2)).map((r) => r.date)).toEqual([day('2026-01-05')]);
    const batch = await repos.importBatch.findById('batch-1', 'u');
    expect(Object.keys(batch?.preImage ?? {})).toEqual(['1:1:20250303:Squat:1', 'macrocycle-row:1']);

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('macrocycle.renumber');
    expect(span.attributes).toMatchObject({
      'renumber.macrocycles': 2,
      'renumber.rows_rewritten': 4,
      'renumber.batches_rewritten': 1,
    });
    expect(span.attributes['renumber.duration_ms']).toEqual(expect.any(Number));
    expect(span.attributes['renumber.lock_wait_ms']).toEqual(expect.any(Number));
  });

  it('needs no exclusive lock when nothing moves', async () => {
    process.env[RENUMBERING_SETTING] = 'on';
    const macrocycle = new InMemoryMacrocycleRepository([macrocycleRowFixture(1)]);
    macrocycle.lockHeld = 'shared';

    expect(await renumberProgram({ macrocycle, importBatch: new InMemoryImportBatchRepository() }, PROGRAM)).toEqual(
      new Map(),
    );
  });

  it('refuses before moving anything when a row is left on a number it needs, naming the store', async () => {
    process.env[RENUMBERING_SETTING] = 'on';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const skips = new InMemoryWorkoutSkipOverrideRepository();
      const liftRecord = new InMemoryLiftRecordRepository(new Map());
      // Macrocycle 2 starts first, so 2 → 1, 1 → 2 and 4 → 3. A set is left on number 3,
      // which nothing moves off; the skip on 1 would move if anything did.
      await skips.skipWorkout(PROGRAM, 1, 4);
      await liftRecord.appendLiftRecords(PROGRAM, [record(3, '2025-01-06')]);
      const macrocycle = new InMemoryMacrocycleRepository([
        macrocycleRowFixture(1, { startDate: day('2026-01-05') }),
        macrocycleRowFixture(2, { startDate: day('2025-03-03') }),
        macrocycleRowFixture(4, { startDate: day('2026-06-01') }),
      ]);
      macrocycle.attachNumbered([liftRecord, skips]);
      const repos = { macrocycle, importBatch: new InMemoryImportBatchRepository() };

      await expect(renumberProgram(repos, PROGRAM)).rejects.toBeInstanceOf(MacrocycleNumberConflictError);

      // Nothing moved: not the macrocycles, the set or the skip.
      expect((await macrocycle.list(PROGRAM)).map((m) => m.macrocycleNum)).toEqual([2, 1, 4]);
      expect(await liftRecord.getLiftRecords(PROGRAM, 3)).toHaveLength(1);
      expect(await skips.getSkipsForMacrocycle(PROGRAM, 1)).toEqual(new Set([4]));
      const [span] = exporter.getFinishedSpans();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes).toMatchObject({
        'renumber.conflict_table': 'lift_record',
        'renumber.conflict_number': 3,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ program: PROGRAM, heldNumber: 3, moves: { 2: 1, 1: 2, 4: 3 } }),
        'Renumbering failed',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('answers 409 macrocycle-busy, moving nothing, when page writes hold the lock it must upgrade', async () => {
    process.env[RENUMBERING_SETTING] = 'on';
    const repos = await outOfOrder();
    repos.macrocycle.lockHeld = 'shared';

    await expect(renumberProgram(repos, PROGRAM)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'macrocycle-busy' }),
    });

    expect(await numbersByStart(repos)).toEqual([['2025-03-03', 2], ['2026-01-05', 1]]);
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.map((e) => e.name)).toEqual(['exception']);
  });
});
