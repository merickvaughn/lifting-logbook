import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseLiftingProgramSpec, validateProgramSpecImport } from '@lifting-logbook/core';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

/**
 * #1312: a program spec with no Week column imports as week 1. Its `Offset -1` row is then
 * rejected by the custom-program endpoint (`@Min(0)` on offset, a day before the macrocycle
 * start has no place in the schedule), with an error that names the row and the reason.
 * Validation runs before the handler, so no database is needed.
 */
describe('Program spec with no Week column -> custom program (#1312, e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects the Offset -1 row, naming its index and the reason', async () => {
    const header = ['Offset', 'Lift', 'Increment', 'Order', 'Sets', 'Reps', 'AMRAP?', 'Warm-Up %', 'WT Decrement %', 'Activation'];
    const parsed = parseLiftingProgramSpec([
      header,
      ['0', 'Bench Press', '5', '1', '3', '5', 'TRUE', '40,60', '0.05', ''],
      ['-1', 'Squat', '5', '1', '3', '5', 'FALSE', '40,60', '0.05', ''],
    ]);
    expect(validateProgramSpecImport(parsed).errors).toEqual([]);
    expect(parsed.map((r) => r.week)).toEqual([1, 1]);

    const specs = parsed.map(({ week, offset, lift, increment, order, sets, reps, amrap, warmUpPct, wtDecrementPct, activation }) => ({
      week, offset, lift, increment, order, sets, reps, amrap, warmUpPct, wtDecrementPct, activation,
    }));
    const res = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/programs/custom',
      headers: { authorization: 'Bearer spec-no-week-e2e', 'content-type': 'application/json' },
      payload: JSON.stringify({ name: '2026', specs }),
    });
    expect(res.statusCode).toBe(400);
    const { message } = res.json() as { message: string[] };
    // Offset -1 sorts first, so it is specs[0].
    expect(message).toEqual(['specs.0.offset must not be less than 0']);
  });
});
