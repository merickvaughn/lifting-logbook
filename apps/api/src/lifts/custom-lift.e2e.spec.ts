import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { CustomLiftResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { SEED_PROGRAM } from '../adapters/in-memory/fixtures';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';

describe('Custom Lifts HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    // Sourced from the shared constant (previously a byte-identical-by-convention
    // literal) so it can't silently diverge from main.ts (#893 review).
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const AUTH = { authorization: 'Bearer dev-token' };

  const inject = (
    method: string,
    url: string,
    opts: { headers?: Record<string, string>; body?: unknown } = {},
  ) => {
    const headers = opts.headers ?? AUTH;
    if (opts.body !== undefined) {
      return app.getHttpAdapter().getInstance().inject({
        method: method as 'GET',
        url,
        headers: { 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(opts.body),
      });
    }
    return app.getHttpAdapter().getInstance().inject({ method: method as 'GET', url, headers });
  };

  const create = (body: unknown, headers?: Record<string, string>) =>
    inject('POST', '/lifts/custom', { body, headers });

  it('creates a custom lift, returning a uuid id and isCustom:true', async () => {
    const res = await create({
      name: 'Safety Bar Squat',
      classification: 'compound',
      movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    });
    expect(res.statusCode).toBe(201);
    const lift = res.json() as CustomLiftResponse;
    expect(lift.id).toMatch(/[0-9a-f-]{36}/);
    expect(lift.name).toBe('Safety Bar Squat');
    expect(lift.classification).toBe('compound');
    expect(lift.movementProfile).toEqual({
      patterns: ['squat'],
      jointActions: ['flexion', 'extension'],
      complexity: 'compound',
    });
    expect(lift.isBodyweightComponent).toBe(false);
    expect(lift.isCustom).toBe(true);
    expect(typeof lift.createdAt).toBe('string');
  });

  it('defaults movementProfile to an empty simple profile when omitted', async () => {
    const res = await create({ name: 'Profileless Lift', classification: 'accessory' });
    expect(res.statusCode).toBe(201);
    const lift = res.json() as CustomLiftResponse;
    expect(lift.movementProfile).toEqual({ patterns: [], jointActions: [], complexity: 'simple' });
  });

  it('lists the created custom lift', async () => {
    await create({ name: 'Pin Press', classification: 'compound' });
    const res = await inject('GET', '/lifts/custom');
    expect(res.statusCode).toBe(200);
    const lifts = res.json() as CustomLiftResponse[];
    expect(lifts.some((l) => l.name === 'Pin Press')).toBe(true);
  });

  it('rejects a duplicate name with 409', async () => {
    await create({ name: 'Zercher Squat', classification: 'compound' });
    const dup = await create({ name: 'Zercher Squat', classification: 'accessory' });
    expect(dup.statusCode).toBe(409);
  });

  // #911 review: a case-variant of a canonical alias (e.g. "squat" for "Squat")
  // would otherwise create successfully — custom-lift name uniqueness is scoped
  // to this user and is exact-case — but buildEffectiveSlotMap always lets
  // DEFAULT_SLOT_MAP win on an exact-case collision, so that lift would never
  // actually be reachable by that name at import time, silently fragmenting
  // its history across two ids.
  it('rejects a name matching a canonical alias case-insensitively with 409', async () => {
    const exact = await create({ name: 'Squat', classification: 'compound' });
    expect(exact.statusCode).toBe(409);

    const lower = await create({ name: 'squat', classification: 'compound' });
    expect(lower.statusCode).toBe(409);

    const mixedAbbreviation = await create({ name: 'bench p.', classification: 'compound' });
    expect(mixedAbbreviation.statusCode).toBe(409);
  });

  it('rejects a PATCH rename to a name matching a canonical alias case-insensitively', async () => {
    const created = await create({ name: 'Rename Target Lift', classification: 'compound' });
    const { id } = created.json() as CustomLiftResponse;

    const res = await inject('PATCH', `/lifts/custom/${id}`, { body: { name: 'DEADLIFT' } });
    expect(res.statusCode).toBe(409);
  });

  it('updates classification, movementProfile and name via PATCH', async () => {
    const created = await create({ name: 'Belt Squat', classification: 'accessory' });
    const id = (created.json() as CustomLiftResponse).id;
    const res = await inject('PATCH', `/lifts/custom/${id}`, {
      body: {
        classification: 'compound',
        movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
        name: 'Belt Squat v2',
      },
    });
    expect(res.statusCode).toBe(200);
    const lift = res.json() as CustomLiftResponse;
    expect(lift.id).toBe(id);
    expect(lift.classification).toBe('compound');
    expect(lift.movementProfile).toEqual({
      patterns: ['squat'],
      jointActions: ['flexion', 'extension'],
      complexity: 'compound',
    });
    expect(lift.name).toBe('Belt Squat v2');
  });

  it('returns 404 when PATCHing an unknown id', async () => {
    const res = await inject('PATCH', '/lifts/custom/does-not-exist', {
      body: { classification: 'compound' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a custom lift and returns 204', async () => {
    const created = await create({ name: 'Hack Squat', classification: 'accessory' });
    const id = (created.json() as CustomLiftResponse).id;
    const del = await inject('DELETE', `/lifts/custom/${id}`);
    expect(del.statusCode).toBe(204);
    const list = await inject('GET', '/lifts/custom');
    expect((list.json() as CustomLiftResponse[]).some((l) => l.id === id)).toBe(false);
  });

  it('returns 404 when DELETEing an unknown id', async () => {
    const res = await inject('DELETE', '/lifts/custom/does-not-exist');
    expect(res.statusCode).toBe(404);
  });

  describe('validation', () => {
    it('rejects a missing name with 400', async () => {
      const res = await create({ classification: 'compound' });
      expect(res.statusCode).toBe(400);
    });
    it('rejects an invalid classification with 400', async () => {
      const res = await create({ name: 'Bad Class', classification: 'isolation' });
      expect(res.statusCode).toBe(400);
    });
    it('rejects an invalid movement pattern with 400', async () => {
      const res = await create({
        name: 'Bad Pattern',
        classification: 'compound',
        movementProfile: { patterns: ['twist'], jointActions: [], complexity: 'simple' },
      });
      expect(res.statusCode).toBe(400);
    });
    it('rejects an invalid joint action with 400', async () => {
      const res = await create({
        name: 'Bad Joint',
        classification: 'compound',
        movementProfile: { patterns: ['squat'], jointActions: ['rotation'], complexity: 'compound' },
      });
      expect(res.statusCode).toBe(400);
    });
    it('rejects an invalid complexity with 400', async () => {
      const res = await create({
        name: 'Bad Complexity',
        classification: 'compound',
        movementProfile: { patterns: ['squat'], jointActions: [], complexity: 'multi' },
      });
      expect(res.statusCode).toBe(400);
    });
    it('rejects a primitive movementProfile with 400 (no nested no-op bypass)', async () => {
      const res = await create({ name: 'Primitive Profile', classification: 'compound', movementProfile: 'squat' });
      expect(res.statusCode).toBe(400);
    });
    it('rejects an unknown extra field with 400', async () => {
      const res = await create({ name: 'Extra Field', classification: 'compound', userId: 'hacker' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('ownership isolation', () => {
    const AS_CLARKE = { authorization: 'Bearer user-clarke-lifts' };
    const AS_DANA = { authorization: 'Bearer user-dana-lifts' };

    it("user B cannot see, update, or delete user A's custom lift", async () => {
      const created = await create(
        { name: 'Clarke Special', classification: 'compound' },
        AS_CLARKE,
      );
      expect(created.statusCode).toBe(201);
      const id = (created.json() as CustomLiftResponse).id;

      // Dana's list does not include Clarke's lift
      const danaList = await inject('GET', '/lifts/custom', { headers: AS_DANA });
      expect((danaList.json() as CustomLiftResponse[]).some((l) => l.id === id)).toBe(false);

      // Dana cannot update Clarke's lift
      const danaUpdate = await inject('PATCH', `/lifts/custom/${id}`, {
        headers: AS_DANA,
        body: { classification: 'accessory' },
      });
      expect(danaUpdate.statusCode).toBe(404);

      // Dana cannot delete Clarke's lift
      const danaDelete = await inject('DELETE', `/lifts/custom/${id}`, { headers: AS_DANA });
      expect(danaDelete.statusCode).toBe(404);

      // Clarke still has it
      const clarkeList = await inject('GET', '/lifts/custom', { headers: AS_CLARKE });
      expect((clarkeList.json() as CustomLiftResponse[]).some((l) => l.id === id)).toBe(true);
    });
  });

  describe('consumption: GET /programs/:program/lifts', () => {
    const AS_PICKER = { authorization: 'Bearer user-picker-lifts' };

    it('includes the user custom lift names in the selectable lifts list', async () => {
      await create({ name: 'Trap Bar Deadlift', classification: 'compound' }, AS_PICKER);
      const res = await inject('GET', `/programs/${SEED_PROGRAM}/lifts`, { headers: AS_PICKER });
      expect(res.statusCode).toBe(200);
      const lifts = res.json() as string[];
      expect(lifts).toContain('Trap Bar Deadlift');
      expect(lifts).toContain('Squat'); // built-ins still present
    });
  });
});
