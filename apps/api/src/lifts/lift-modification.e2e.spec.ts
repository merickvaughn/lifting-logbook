import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { LiftModificationResponse, LiftRecordResponse, WorkoutResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { SEED_PROGRAM } from '../adapters/in-memory/fixtures';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { injectPage } from '../testing/macrocycle-id';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

describe('Lift modifications HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new DomainNotFoundFilter(), new DomainConflictFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const inject = (user: string, method: string, url: string, body?: unknown) =>
    injectPage(app, {
      method: method as 'GET',
      url,
      headers:
        body === undefined
          ? { authorization: `Bearer ${user}` }
          : { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  /**
   * Each test takes its own user, since the in-memory factory keeps a bundle per user. A user's
   * first request starts rpt's macrocycle 1, which has to exist to take sets (ADR-042).
   */
  const started = new Set<string>();
  const as = (user: string) => async (method: string, url: string, body?: unknown) => {
    if (!started.has(user)) {
      started.add(user);
      await inject(user, 'POST', '/programs/rpt/macrocycles/initialize', {});
    }
    return inject(user, method, url, body);
  };

  const set = (overrides: Record<string, unknown> = {}) => ({
    macrocycleNum: 1,
    workoutNum: 1,
    date: '2026-04-20',
    lift: 'Bench Press',
    setNum: 1,
    weight: 180,
    reps: 5,
    ...overrides,
  });

  async function createOn(
    request: ReturnType<typeof as>,
    lift: string,
    name: string,
    maxMode?: string,
  ): Promise<LiftModificationResponse> {
    const res = await request('POST', '/lifts/modifications', { lift, name, ...(maxMode ? { maxMode } : {}) });
    expect(res.statusCode).toBe(201);
    return res.json() as LiftModificationResponse;
  }

  describe('managing modifications', () => {
    it('creates two on one lift, lists them, renames one, and answers 409 on a duplicate name', async () => {
      const user = as('mods-crud');
      const wide = await createOn(user, 'Cable Curl', 'Wide grip', 'own');
      const res = await user('POST', '/lifts/modifications', {
        lift: 'Cable Curl',
        name: 'No chalk',
        description: 'Bare hands',
      });
      expect(res.statusCode).toBe(201);
      const noChalk = res.json() as LiftModificationResponse;
      expect(wide).toMatchObject({ lift: 'cable-curl', name: 'Wide grip', description: '', maxMode: 'own' });
      expect(noChalk).toMatchObject({ lift: 'cable-curl', description: 'Bare hands', maxMode: 'none' });
      expect(wide).not.toHaveProperty('userId');

      const listed = (await user('GET', '/lifts/modifications')).json() as LiftModificationResponse[];
      expect(listed.map((m) => m.name)).toEqual(['No chalk', 'Wide grip']);

      const renamed = await user('PATCH', `/lifts/modifications/${noChalk.id}`, { name: 'Straps' });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ id: noChalk.id, name: 'Straps', description: 'Bare hands' });

      const duplicate = await user('POST', '/lifts/modifications', { lift: 'Cable Curl', name: 'Straps' });
      expect(duplicate.statusCode).toBe(409);
      const renameOntoTaken = await user('PATCH', `/lifts/modifications/${wide.id}`, { name: 'Straps' });
      expect(renameOntoTaken.statusCode).toBe(409);
    });

    it('allows one name on two lifts', async () => {
      const user = as('mods-two-lifts');
      await createOn(user, 'Deadlift', 'Paused');
      await createOn(user, 'Squat', 'Paused');
      expect((await user('GET', '/lifts/modifications')).json()).toHaveLength(2);
    });

    it('treats another spelling of a lift as that lift, for create and for the list filter', async () => {
      const user = as('mods-spelling');
      await createOn(user, 'Bench Press', 'Paused');
      const duplicate = await user('POST', '/lifts/modifications', { lift: 'bench-press', name: 'Paused' });
      expect(duplicate.statusCode).toBe(409);

      await createOn(user, 'Squat', 'Paused');
      const filtered = (await user('GET', '/lifts/modifications?lift=Bench%20P.')).json() as LiftModificationResponse[];
      expect(filtered.map((m) => m.lift)).toEqual(['bench-press']);
      expect((await user('GET', '/lifts/modifications?lift=Nothing')).json()).toEqual([]);
    });

    it('stores a custom lift by its id, and reads it back under the custom lift name', async () => {
      const user = as('mods-custom-lift');
      const custom = await user('POST', '/lifts/custom', { name: 'Safety Bar Squat', classification: 'compound' });
      const { id } = custom.json() as { id: string };
      const modification = await createOn(user, 'Safety Bar Squat', 'Paused');
      expect(modification.lift).toBe(id);
      const filtered = await user('GET', '/lifts/modifications?lift=Safety%20Bar%20Squat');
      expect((filtered.json() as LiftModificationResponse[]).map((m) => m.id)).toEqual([modification.id]);
    });

    it.each([
      ['a lift that resolves to nothing', { lift: 'Nothing', name: 'Paused' }],
      ['a blank name', { lift: 'Squat', name: '   ' }],
      ['a null name', { lift: 'Squat', name: null }],
      ['a name that is too long', { lift: 'Squat', name: 'x'.repeat(101) }],
      ['a description that is too long', { lift: 'Squat', name: 'Paused', description: 'x'.repeat(501) }],
      ['an unknown maxMode', { lift: 'Squat', name: 'Paused', maxMode: 'other' }],
      ['an undeclared field', { lift: 'Squat', name: 'Paused', alternativeNames: ['Paused Squat'] }],
    ])('answers 400 for %s', async (_label, body) => {
      expect((await as('mods-invalid')('POST', '/lifts/modifications', body)).statusCode).toBe(400);
    });

    it.each([
      ['a blank name', { name: '   ' }],
      ['a null name', { name: null }],
      ['a name that is too long', { name: 'x'.repeat(101) }],
      ['a null description', { description: null }],
      ['a description that is too long', { description: 'x'.repeat(501) }],
      ['an unknown maxMode', { maxMode: 'other' }],
      ['an undeclared field', { lift: 'Deadlift' }],
    ])('answers 400 to a PATCH with %s', async (_label, body) => {
      const user = as('mods-invalid-patch');
      const name = `Paused ${_label}`;
      const { id } = await createOn(user, 'Squat', name);
      expect((await user('PATCH', `/lifts/modifications/${id}`, body)).statusCode).toBe(400);
    });

    it('answers 404 to PATCH and DELETE on an unknown id', async () => {
      const user = as('mods-unknown');
      expect((await user('PATCH', '/lifts/modifications/nope', { name: 'x' })).statusCode).toBe(404);
      expect((await user('DELETE', '/lifts/modifications/nope')).statusCode).toBe(404);
    });
  });

  describe("another user's modification", () => {
    it('is neither listed nor editable, and a set naming it gets a 400', async () => {
      const owner = as('mods-owner');
      const other = as('mods-other');
      const modification = await createOn(owner, 'Bench Press', 'Paused');

      expect((await other('GET', '/lifts/modifications')).json()).toEqual([]);
      expect((await other('PATCH', `/lifts/modifications/${modification.id}`, { name: 'x' })).statusCode).toBe(404);
      expect((await other('DELETE', `/lifts/modifications/${modification.id}`)).statusCode).toBe(404);

      const logged = await other(
        'POST',
        '/programs/rpt/lift-records',
        set({ modifications: [modification.id] }),
      );
      expect(logged.statusCode).toBe(400);
    });
  });

  describe('the record fields', () => {
    it('stores the ids on a set, and names them in the response', async () => {
      const user = as('mods-set');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      const res = await user('POST', '/programs/rpt/lift-records', set({ modifications: [paused.id] }));
      expect(res.statusCode).toBe(201);
      const record = res.json() as LiftRecordResponse;
      expect(record.modifications).toEqual([{ id: paused.id, name: 'Paused' }]);
      // Modifications are not part of the public id: it is still set 1 of this lift.
      expect(record.id).toBe('rpt-1-1-20260420-Bench Press-1');
    });

    it('attaches a modification on a lift spelled differently', async () => {
      const user = as('mods-set-spelling');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      const res = await user('POST', '/programs/rpt/lift-records', set({ lift: 'bench-press', modifications: [paused.id] }));
      expect(res.statusCode).toBe(201);
      expect((res.json() as LiftRecordResponse).modifications).toEqual([{ id: paused.id, name: 'Paused' }]);
    });

    it.each([
      ['before', true],
      ['after', false],
    ])('attaches under every spelling when a custom lift sharing a catalog name is made %s it', async (_label, customFirst) => {
      const user = as(`mods-set-namesake-${_label}`);
      const makeCustom = () => user('POST', '/lifts/custom', { name: 'Cable Curl', classification: 'accessory' });
      if (customFirst) expect((await makeCustom()).statusCode).toBe(201);
      const wide = await createOn(user, 'Cable Curl', 'Wide grip');
      if (!customFirst) expect((await makeCustom()).statusCode).toBe(201);

      const lifts = ['Cable Curl', 'cable-curl', 'Cable Curls'];
      for (const [i, lift] of lifts.entries()) {
        const logged = await user('POST', '/programs/rpt/lift-records', set({ lift, setNum: i + 1, modifications: [wide.id] }));
        expect(logged.statusCode).toBe(201);
        const filtered = await user('GET', `/lifts/modifications?lift=${encodeURIComponent(lift)}`);
        expect((filtered.json() as LiftModificationResponse[]).map((m) => m.id)).toEqual([wide.id]);
      }
    });

    it('keeps a modification on a set when its custom lift is renamed, but takes no new one', async () => {
      const user = as('mods-set-custom-rename');
      const custom = await user('POST', '/lifts/custom', { name: 'Old Curl', classification: 'accessory' });
      const { id: customId } = custom.json() as { id: string };
      const wide = await createOn(user, 'Old Curl', 'Wide grip');
      const narrow = await createOn(user, 'Old Curl', 'Narrow grip');
      const logged = await user('POST', '/programs/rpt/lift-records', set({ lift: 'Old Curl', modifications: [wide.id] }));
      const url = `/programs/rpt/lift-records/${encodeURIComponent((logged.json() as LiftRecordResponse).id)}`;
      expect((await user('PATCH', `/lifts/custom/${customId}`, { name: 'New Curl' })).statusCode).toBe(200);

      const kept = await user('PATCH', url, { reps: 6, modifications: [wide.id] });
      expect(kept.statusCode).toBe(200);
      expect((kept.json() as LiftRecordResponse).modifications).toEqual([{ id: wide.id, name: 'Wide grip' }]);
      expect((await user('PATCH', url, { modifications: [wide.id, narrow.id] })).statusCode).toBe(400);
    });

    it('leaves the field out of a set with none, sent as absent or empty', async () => {
      const user = as('mods-set-none');
      const absent = await user('POST', '/programs/rpt/lift-records', set());
      expect(absent.statusCode).toBe(201);
      expect(absent.json()).not.toHaveProperty('modifications');
      const empty = await user('POST', '/programs/rpt/lift-records', set({ setNum: 2, modifications: [] }));
      expect(empty.statusCode).toBe(201);
      expect(empty.json()).not.toHaveProperty('modifications');
    });

    it("rejects a modification of a different lift, and leaves no set behind", async () => {
      const user = as('mods-set-other-lift');
      const paused = await createOn(user, 'Squat', 'Paused');
      const res = await user('POST', '/programs/rpt/lift-records', set({ modifications: [paused.id] }));
      expect(res.statusCode).toBe(400);
      expect((await user('POST', '/programs/rpt/lift-records', set())).statusCode).toBe(201);
    });

    it('rejects two `own` modifications on one set, and allows one beside the others', async () => {
      const user = as('mods-set-own');
      const wide = await createOn(user, 'Cable Curl', 'Wide grip', 'own');
      const narrow = await createOn(user, 'Cable Curl', 'Narrow grip', 'own');
      const mixed = await createOn(user, 'Cable Curl', 'Mixed grip', 'lift');
      const noChalk = await createOn(user, 'Cable Curl', 'No chalk');
      const lift = 'Cable Curl';

      const twoOwn = await user('POST', '/programs/rpt/lift-records', set({ lift, modifications: [wide.id, narrow.id] }));
      expect(twoOwn.statusCode).toBe(400);
      // Coded, so the logger shows the reason as is (#1152).
      expect(twoOwn.json()).toEqual(
        expect.objectContaining({
          code: 'one-own-modification',
          message: 'A set can have only one modification with its own max',
        }),
      );
      const oneOwn = await user(
        'POST',
        '/programs/rpt/lift-records',
        set({ lift, modifications: [wide.id, mixed.id, noChalk.id] }),
      );
      expect(oneOwn.statusCode).toBe(201);
    });

    it('shows a rename on sets already logged', async () => {
      const user = as('mods-set-rename');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      await user('POST', '/programs/rpt/lift-records', set({ modifications: [paused.id] }));
      await user('PATCH', `/lifts/modifications/${paused.id}`, { name: 'Long pause' });
      const edited = await user('PATCH', '/programs/rpt/lift-records/rpt-1-1-20260420-Bench Press-1', { reps: 6 });
      expect(edited.statusCode).toBe(200);
      expect((edited.json() as LiftRecordResponse).modifications).toEqual([{ id: paused.id, name: 'Long pause' }]);
    });

    it('replaces the list on PATCH under the same rules, and an empty list clears it', async () => {
      const user = as('mods-set-patch');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      const wide = await createOn(user, 'Bench Press', 'Wide grip', 'own');
      const narrow = await createOn(user, 'Bench Press', 'Narrow grip', 'own');
      const squatOnly = await createOn(user, 'Squat', 'High bar');
      await user('POST', '/programs/rpt/lift-records', set({ modifications: [paused.id] }));
      const url = '/programs/rpt/lift-records/rpt-1-1-20260420-Bench Press-1';

      const replaced = await user('PATCH', url, { modifications: [wide.id] });
      expect(replaced.statusCode).toBe(200);
      expect((replaced.json() as LiftRecordResponse).modifications).toEqual([{ id: wide.id, name: 'Wide grip' }]);

      // Leaving the field out leaves the list alone.
      const unchanged = await user('PATCH', url, { reps: 6 });
      expect((unchanged.json() as LiftRecordResponse).modifications).toEqual([{ id: wide.id, name: 'Wide grip' }]);

      expect((await user('PATCH', url, { modifications: [wide.id, narrow.id] })).statusCode).toBe(400);
      expect((await user('PATCH', url, { modifications: [squatOnly.id] })).statusCode).toBe(400);

      const cleared = await user('PATCH', url, { modifications: [] });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).not.toHaveProperty('modifications');
    });

    it('answers 404, not 400, to a PATCH with modifications on an id that addresses no record', async () => {
      const user = as('mods-set-patch-404');
      const unparseable = await user('PATCH', '/programs/rpt/lift-records/not-an-id', { modifications: ['x'] });
      expect(unparseable.statusCode).toBe(404);
      const noRow = await user('PATCH', '/programs/rpt/lift-records/rpt-1-1-20260420-Squat-1', { modifications: ['x'] });
      expect(noRow.statusCode).toBe(404);
    });

    it('treats a retry as the same write only when its modifications match', async () => {
      const user = as('mods-set-retry');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      const noChalk = await createOn(user, 'Bench Press', 'No chalk');
      const both = set({ modifications: [paused.id, noChalk.id] });
      expect((await user('POST', '/programs/rpt/lift-records', both)).statusCode).toBe(201);

      const reordered = await user('POST', '/programs/rpt/lift-records', set({ modifications: [noChalk.id, paused.id] }));
      expect(reordered.statusCode).toBe(201);
      expect((reordered.json() as LiftRecordResponse).modifications).toHaveLength(2);

      const different = await user('POST', '/programs/rpt/lift-records', set({ modifications: [paused.id] }));
      expect(different.statusCode).toBe(409);
    });
  });

  describe('deleting', () => {
    it('removes a modification no set names', async () => {
      const user = as('mods-delete-unused');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      expect((await user('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(204);
      expect((await user('GET', '/lifts/modifications')).json()).toEqual([]);
      // Gone, not archived: another delete has nothing to find.
      expect((await user('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(404);
    });

    it('archives one a set names: gone from the list, still named by the set on every read', async () => {
      const user = as('dev-token');
      const paused = await createOn(user, 'Squat', 'Paused');
      const logged = await user(
        'POST',
        `/programs/${SEED_PROGRAM}/lift-records`,
        set({ lift: 'Squat', setNum: 40, modifications: [paused.id] }),
      );
      expect(logged.statusCode).toBe(201);
      const { id } = logged.json() as LiftRecordResponse;
      const named = [{ id: paused.id, name: 'Paused' }];

      expect((await user('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(204);
      expect((await user('GET', '/lifts/modifications')).json()).toEqual([]);

      const records = (await user('GET', `/programs/${SEED_PROGRAM}/lift-records`)).json() as LiftRecordResponse[];
      expect(records.find((r) => r.id === id)?.modifications).toEqual(named);

      const workout = (await user('GET', `/programs/${SEED_PROGRAM}/workouts/1`)).json() as WorkoutResponse;
      const sets = workout.lifts.flatMap((l) => l.sets);
      expect(sets.find((s) => s.id === id)?.modifications).toEqual(named);
      // The workout's other sets stay as they were.
      expect(sets.filter((s) => s.id !== id).every((s) => !('modifications' in s))).toBe(true);

      // An archived one takes no edits, and a set that names it can still be edited.
      expect((await user('PATCH', `/lifts/modifications/${paused.id}`, { name: 'x' })).statusCode).toBe(404);
      const edited = await user('PATCH', `/programs/${SEED_PROGRAM}/lift-records/${id}`, {
        reps: 6,
        modifications: [paused.id],
      });
      expect(edited.statusCode).toBe(200);
      expect((edited.json() as LiftRecordResponse).modifications).toEqual(named);
    });

    it('brings an archived modification back when its name is created again', async () => {
      const user = as('mods-restore');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      await user('POST', '/programs/rpt/lift-records', set({ modifications: [paused.id] }));
      await user('DELETE', `/lifts/modifications/${paused.id}`);

      const res = await user('POST', '/lifts/modifications', {
        lift: 'Bench Press',
        name: 'Paused',
        description: 'Two seconds',
        maxMode: 'lift',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: paused.id, description: 'Two seconds', maxMode: 'lift' });
      const listed = (await user('GET', '/lifts/modifications')).json() as LiftModificationResponse[];
      expect(listed.map((m) => m.id)).toEqual([paused.id]);
    });

    it('removes an archived modification once no set names it', async () => {
      const user = as('mods-archived-then-unused');
      const paused = await createOn(user, 'Bench Press', 'Paused');
      await user('POST', '/programs/rpt/lift-records', set({ modifications: [paused.id] }));
      await user('DELETE', `/lifts/modifications/${paused.id}`);
      // Still named: another delete changes nothing.
      expect((await user('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(204);
      await user('PATCH', '/programs/rpt/lift-records/rpt-1-1-20260420-Bench Press-1', { modifications: [] });
      expect((await user('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(204);
      expect((await user('DELETE', `/lifts/modifications/${paused.id}`)).statusCode).toBe(404);
    });
  });

  describe('own maxes (#1153)', () => {
    const url = '/programs/rpt/modification-maxes';

    it('sets, replaces and lists an own max, and keeps it per program', async () => {
      const user = as('mods-own-max');
      const wide = await createOn(user, 'Cable Curl', 'Wide grip', 'own');

      const res = await user('PUT', `${url}/${wide.id}`, { weight: 65 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ modificationId: wide.id, weight: 65, unit: 'lbs' });
      await user('PUT', `${url}/${wide.id}`, { weight: 67.5 });

      expect((await user('GET', url)).json()).toEqual([
        expect.objectContaining({ modificationId: wide.id, weight: 67.5 }),
      ]);
      expect((await user('GET', '/programs/5-3-1/modification-maxes')).json()).toEqual([]);
    });

    it("answers 400 for a modification that doesn't keep its own max, and 404 for one that isn't yours", async () => {
      const user = as('mods-own-max-refused');
      const noChalk = await createOn(user, 'Cable Curl', 'No chalk');
      expect((await user('PUT', `${url}/${noChalk.id}`, { weight: 65 })).statusCode).toBe(400);

      const wide = await createOn(user, 'Cable Curl', 'Wide grip', 'own');
      const stranger = as('mods-own-max-stranger');
      expect((await stranger('PUT', `${url}/${wide.id}`, { weight: 65 })).statusCode).toBe(404);
      expect((await stranger('GET', url)).json()).toEqual([]);
      expect((await user('GET', url)).json()).toEqual([]);
    });

    it('validates the weight like a training max', async () => {
      const user = as('mods-own-max-weight');
      const wide = await createOn(user, 'Cable Curl', 'Wide grip', 'own');
      for (const weight of [0, -5, '65', undefined]) {
        expect((await user('PUT', `${url}/${wide.id}`, { weight })).statusCode).toBe(400);
      }
    });

    it("lists an own max only while its modification's mode is own, and keeps it across a change", async () => {
      const user = as('mods-own-max-mode');
      const wide = await createOn(user, 'Cable Curl', 'Wide grip', 'own');
      await user('PUT', `${url}/${wide.id}`, { weight: 65 });

      await user('PATCH', `/lifts/modifications/${wide.id}`, { maxMode: 'lift' });
      expect((await user('GET', url)).json()).toEqual([]);

      await user('PATCH', `/lifts/modifications/${wide.id}`, { maxMode: 'own' });
      expect((await user('GET', url)).json()).toEqual([expect.objectContaining({ modificationId: wide.id, weight: 65 })]);
    });

    it('drops the own max of a modification that is removed', async () => {
      const user = as('mods-own-max-removed');
      const wide = await createOn(user, 'Cable Curl', 'Wide grip', 'own');
      await user('PUT', `${url}/${wide.id}`, { weight: 65 });

      await user('DELETE', `/lifts/modifications/${wide.id}`);

      expect((await user('GET', url)).json()).toEqual([]);
    });
  });
});
