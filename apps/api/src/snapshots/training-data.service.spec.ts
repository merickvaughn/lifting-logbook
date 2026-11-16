import { ConflictException } from '@nestjs/common';
import { TrainingDataCounts } from '@lifting-logbook/types';
import { TRAINING_TABLES, TrainingData } from '../ports/ITrainingDataRepository';
import { NON_CYCLE_ROW_KEY } from '../programs/macrocycle-history.util';
import { clearTrainingData, shiftNonCycleKey } from './training-data.service';

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

describe('clearTrainingData (#1309)', () => {
  const data = (sets = 1): TrainingData => {
    const out: Partial<TrainingData> = {};
    for (const table of TRAINING_TABLES) out[table] = [];
    out.liftRecords = Array.from({ length: sets }, (_, i) => ({ program: '5-3-1', macrocycleNum: 1, workoutNum: i + 1 }));
    return out as TrainingData;
  };
  const counts = (liftRecords: number): TrainingDataCounts => {
    const out: Partial<TrainingDataCounts> = {};
    for (const table of TRAINING_TABLES) out[table] = 0;
    out.liftRecords = liftRecords;
    return out as TrainingDataCounts;
  };

  /** Repositories that lock one set, read `read` and delete `deleted`. */
  function repos({ read = 1, deleted = 1 } = {}) {
    const create = jest.fn(async () => ({ id: 's1' }));
    const clear = jest.fn(async () => counts(deleted));
    const bundle = {
      macrocycle: { tryLockImport: async () => true, lockExclusive: async () => true },
      trainingData: { lockRows: async () => counts(1), read: async () => data(read), clear },
      dataSnapshot: { create },
    };
    return { bundle: bundle as unknown as Parameters<typeof clearTrainingData>[0], create, clear };
  }

  it('saves the snapshot, then clears what it read', async () => {
    const { bundle, create } = repos();

    await expect(clearTrainingData(bundle, counts(1), new Date())).resolves.toEqual({ id: 's1' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ counts: counts(1) }));
  });

  it('is a 409, saving nothing, when it reads a row added after the lock, which isn’t locked', async () => {
    const { bundle, create, clear } = repos({ read: 2 });

    const err = await clearTrainingData(bundle, counts(1), new Date()).catch((e: unknown) => e);

    expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: 'data-changed' });
    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('is a 409 when the delete removes a row the snapshot doesn’t hold, so the transaction rolls back', async () => {
    const { bundle, clear } = repos({ deleted: 2 });

    const err = await clearTrainingData(bundle, counts(1), new Date()).catch((e: unknown) => e);

    expect(clear).toHaveBeenCalled();
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: 'data-changed' });
  });
});
