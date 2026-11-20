import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  SUPPLEMENT_NOT_REMOVED_CODE,
  SupplementAsOfResponse,
  SupplementChange,
  SupplementCreatedResponse,
  SupplementStackResponse,
} from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const TODAY = '2026-11-20';
const DAY_TYPES = [
  { id: 'lift', name: 'Lift day', sessionTime: '17:00' },
  { id: 'rest', name: 'Rest day' },
];

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

describe('Supplements HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;
  let userCount = 0;

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

  /** A fresh user per test, so the in-memory store starts empty. */
  function newUser() {
    const headers = { authorization: `Bearer supplements-e2e-${++userCount}` };
    const inject = (method: Method, url: string, body?: unknown) =>
      app.inject({
        method,
        url,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const get = async () => (await inject('GET', '/supplements')).json<SupplementStackResponse>();
    const asOf = async (date: string) => (await inject('GET', `/supplements/as-of/${date}`)).json<SupplementAsOfResponse>();
    const changes = async () => (await inject('GET', '/supplements/changes')).json<SupplementChange[]>();
    /**
     * A write that must succeed. After it, replaying the log through the write's date gives the
     * stack `GET /` does: the two share applyChange (ADR-046).
     */
    const ok = async <R = SupplementStackResponse>(method: Method, url: string, body?: unknown): Promise<R> => {
      const res = await inject(method, url, body);
      expect([200, 201]).toContain(res.statusCode);
      const today = new URL(url, 'http://x').searchParams.get('today');
      if (today !== null) expect((await asOf(today)).items).toEqual((await get()).items);
      return res.json<R>();
    };
    const add = async (name: string, extra: Record<string, unknown> = {}) => {
      const created = await ok<SupplementCreatedResponse>('POST', `/supplements/items?today=${TODAY}`, { name, ...extra });
      const item = created.items.find((i) => i.id === created.id);
      if (!item) throw new Error(`POST /items didn't return item ${created.id} in the stack`);
      return item;
    };
    const setDayTypes = () => ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: DAY_TYPES });
    return { inject, ok, add, get, asOf, changes, setDayTypes };
  }

  it('lists an empty stack with the default caffeine cutoff', async () => {
    const { get } = newUser();
    expect(await get()).toEqual({ items: [], dayTypes: [], caffeineCutoff: '14:00' });
  });

  it('creates an item with its doses, returns its id, and logs it as added', async () => {
    const { ok, add, changes, setDayTypes } = newUser();
    await setDayTypes();
    const item = await add('Creatine', {
      ingredients: [{ key: 'creatine', amount: 5, unit: 'g' }],
      doses: [{ slot: 'post', amount: '1 scoop', servings: 1, dayTypes: ['lift'] }],
      links: ['https://examine.com/supplements/creatine/'],
    });
    expect(item).toMatchObject({ name: 'Creatine', status: 'active', unverified: false, doses: [{ slot: 'post' }] });
    expect((await changes()).slice(-1)).toEqual([{ type: 'added', date: TODAY, seq: 2, item }]);

    // Names can repeat; the returned id tells the two apart.
    const again = await ok<SupplementCreatedResponse>('POST', `/supplements/items?today=${TODAY}`, { name: 'Creatine' });
    expect(again.id).not.toBe(item.id);
    expect(again.items.map((i) => i.id)).toEqual([item.id, again.id]);
  });

  it('rejects a workout-slot dose with no day type, and logs nothing', async () => {
    const { inject, changes } = newUser();
    const res = await inject('POST', `/supplements/items?today=${TODAY}`, {
      name: 'Caffeine',
      doses: [{ slot: 'pre', amount: '', servings: 1, dayTypes: [] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toEqual(['Caffeine: a pre dose needs at least one day type']);
    expect(await changes()).toEqual([]);
  });

  it('rejects a link that is not an http or https URL', async () => {
    const { inject, changes } = newUser();
    for (const link of ['javascript:alert(1)', 'examine.com', 'ftp://example.com/x']) {
      const res = await inject('POST', `/supplements/items?today=${TODAY}`, { name: 'Bad link', links: [link] });
      expect(res.statusCode).toBe(400);
    }
    expect(await changes()).toEqual([]);
  });

  it('rejects an explicit null rather than storing it or failing on it', async () => {
    const { inject, add, changes, get } = newUser();
    const item = await add('Magnesium');
    for (const field of ['name', 'status', 'doses', 'ingredients', 'links', 'keyCompound', 'unverified']) {
      const res = await inject('PATCH', `/supplements/items/${item.id}?today=${TODAY}`, { [field]: null });
      expect([field, res.statusCode]).toEqual([field, 400]);
    }
    for (const body of [{ dayTypes: null }, { caffeineCutoff: null }, { dayTypes: [{ id: 'x', name: 'X', sessionTime: null }] }]) {
      expect((await inject('PUT', `/supplements/settings?today=${TODAY}`, body)).statusCode).toBe(400);
    }
    expect(await changes()).toHaveLength(1);
    expect((await get()).items).toEqual([item]);
  });

  it('requires today on every write, and refuses one dated before the last change', async () => {
    const { inject, ok, add, changes } = newUser();
    const item = await add('Zinc');
    const writes: [Method, string, unknown?][] = [
      ['POST', '/supplements/items', { name: 'x' }],
      ['PATCH', `/supplements/items/${item.id}`, { name: 'y' }],
      ['DELETE', `/supplements/items/${item.id}`],
      ['POST', `/supplements/items/${item.id}/restore`],
      ['PUT', '/supplements/settings', { caffeineCutoff: '12:00' }],
      ['POST', '/supplements/doses/move', { itemIds: [item.id], from: 'am', to: 'pm' }],
      ['POST', '/supplements/items/status', { itemIds: [item.id], status: 'pending' }],
      ['POST', '/supplements/mixes', { name: 'm', itemIds: [item.id, item.id] }],
      ['POST', `/supplements/mixes/${item.id}/split`],
    ];
    for (const [method, url, body] of writes) {
      const res = await inject(method, url, body);
      expect([url, res.statusCode, res.json().message]).toEqual([url, 400, 'today is required (YYYY-MM-DD)']);
    }

    await ok('PATCH', `/supplements/items/${item.id}?today=2026-11-21`, { name: 'Zinc picolinate' });
    const earlier = await inject('DELETE', `/supplements/items/${item.id}?today=${TODAY}`);
    expect(earlier.statusCode).toBe(400);
    expect(earlier.json().message).toMatch(/before the stack's last change \(2026-11-21\)/);
    expect(await changes()).toHaveLength(2);
    // The same date is fine.
    await ok('DELETE', `/supplements/items/${item.id}?today=2026-11-21`);
  });

  it('refuses a today more than a day past the server date, so it can’t block the writes after it', async () => {
    const { inject, ok, add, changes } = newUser();
    const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    for (const future of ['2099-01-01', daysFromNow(2)]) {
      const res = await inject('POST', `/supplements/items?today=${future}`, { name: 'Typo' });
      expect([future, res.statusCode]).toEqual([future, 400]);
      expect(res.json().message).toMatch(/more than a day past the server's date/);
    }
    expect(await changes()).toEqual([]);

    // Writes dated from now on still succeed, up to a day ahead for a lifter east of UTC.
    await add('Zinc');
    await ok('POST', `/supplements/items?today=${daysFromNow(1)}`, { name: 'Magnesium' });
    expect((await changes()).map((c) => c.type)).toEqual(['added', 'added']);
  });

  it('updates an item, one change per kind of edit', async () => {
    const { ok, add, changes } = newUser();
    const item = await add('Magnesium', { unverified: true });
    const doses = [{ slot: 'pm', amount: '2 caps', servings: 2, dayTypes: [] }];
    const stack = await ok('PATCH', `/supplements/items/${item.id}?today=${TODAY}`, {
      shortNote: 'Glycinate',
      doses,
      status: 'pending',
      unverified: false,
    });
    expect(stack.items[0]).toMatchObject({ shortNote: 'Glycinate', doses, status: 'pending', unverified: false });
    expect((await changes()).slice(1)).toEqual([
      { type: 'edited', date: TODAY, seq: 2, itemId: item.id, changes: { shortNote: 'Glycinate' } },
      { type: 'moved', date: TODAY, seq: 3, itemId: item.id, doses },
      { type: 'moved_to_pending', date: TODAY, seq: 4, itemId: item.id },
      { type: 'confirmed', date: TODAY, seq: 5, itemId: item.id },
    ]);
  });

  it('logs only the fields an update changes, and nothing for an update that changes nothing', async () => {
    const { ok, add, changes } = newUser();
    const item = await add('Fish oil', { shortNote: 'EPA/DHA', doses: [{ slot: 'am', amount: '2', servings: 1, dayTypes: [] }] });
    const { id: _id, parts: _parts, ...whole } = item;
    await ok('PATCH', `/supplements/items/${item.id}?today=${TODAY}`, whole);
    await ok('PATCH', `/supplements/items/${item.id}?today=${TODAY}`, {});
    await ok('PATCH', `/supplements/items/${item.id}?today=${TODAY}`, { ...whole, longNote: 'With food' });
    expect((await changes()).slice(1)).toEqual([
      { type: 'edited', date: TODAY, seq: 2, itemId: item.id, changes: { longNote: 'With food' } },
    ]);
  });

  it('404s an update to an item the user does not have', async () => {
    const { inject } = newUser();
    expect((await inject('PATCH', `/supplements/items/nope?today=${TODAY}`, { name: 'x' })).statusCode).toBe(404);
  });

  it('removes an item, restores it from the log, and 409s a second restore', async () => {
    const { ok, add, inject, changes } = newUser();
    const item = await add('Ashwagandha', { longNote: 'KSM-66' });
    expect((await ok('DELETE', `/supplements/items/${item.id}?today=${TODAY}`)).items).toEqual([]);
    expect((await changes())[1]).toEqual({ type: 'removed', date: TODAY, seq: 2, item });

    expect((await ok('POST', `/supplements/items/${item.id}/restore?today=${TODAY}`)).items).toEqual([item]);
    expect((await changes())[2]).toEqual({ type: 'restored', date: TODAY, seq: 3, itemId: item.id });

    const again = await inject('POST', `/supplements/items/${item.id}/restore?today=${TODAY}`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe(SUPPLEMENT_NOT_REMOVED_CODE);
    expect(await changes()).toHaveLength(3);
  });

  it('puts a restored item at the end of the stack', async () => {
    const { ok, add } = newUser();
    const a = await add('A');
    const b = await add('B');
    await ok('DELETE', `/supplements/items/${a.id}?today=${TODAY}`);
    const stack = await ok('POST', `/supplements/items/${a.id}/restore?today=${TODAY}`);
    expect(stack.items.map((i) => i.id)).toEqual([b.id, a.id]);
  });

  it('404s restoring an item that was never removed', async () => {
    const { inject } = newUser();
    expect((await inject('POST', `/supplements/items/nope/restore?today=${TODAY}`)).statusCode).toBe(404);
  });

  it('sets the caffeine cutoff and day types, taking a removed day type off every dose, each logged', async () => {
    const { ok, add, changes } = newUser();
    await ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: DAY_TYPES, caffeineCutoff: '13:30' });
    const item = await add('Electrolytes', { doses: [{ slot: 'all', amount: '1', servings: 1, dayTypes: ['lift', 'rest'] }] });

    const stack = await ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [DAY_TYPES[0]] });
    expect(stack.caffeineCutoff).toBe('13:30');
    expect(stack.dayTypes).toEqual([DAY_TYPES[0]]);
    expect(stack.items[0]?.doses[0]?.dayTypes).toEqual(['lift']);
    expect(await changes()).toEqual([
      { type: 'caffeine_cutoff_set', date: TODAY, seq: 1, caffeineCutoff: '13:30' },
      { type: 'day_types_set', date: TODAY, seq: 2, dayTypes: DAY_TYPES },
      { type: 'added', date: TODAY, seq: 3, item },
      { type: 'day_types_set', date: TODAY, seq: 4, dayTypes: [DAY_TYPES[0]] },
      { type: 'moved', date: TODAY, seq: 5, itemId: item.id, doses: [{ slot: 'all', amount: '1', servings: 1, dayTypes: ['lift'] }] },
    ]);

    // Settings that match what's stored change nothing and log nothing.
    await ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [DAY_TYPES[0]], caffeineCutoff: '13:30' });
    expect(await changes()).toHaveLength(5);
  });

  it('400s removing the only day type of a workout-slot dose, and saves nothing', async () => {
    const { ok, add, inject, changes, setDayTypes } = newUser();
    await setDayTypes();
    await add('Pre-workout', { doses: [{ slot: 'pre', amount: '1 scoop', servings: 1, dayTypes: ['lift'] }] });

    const res = await inject('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [DAY_TYPES[1]] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toEqual(['Pre-workout: a pre dose needs at least one day type']);
    expect((await ok('GET', '/supplements')).dayTypes).toEqual(DAY_TYPES);
    expect(await changes()).toHaveLength(2);
  });

  it('restores an item after one of its day types was removed, taking it off the doses', async () => {
    const { ok, add, inject, changes, setDayTypes } = newUser();
    await setDayTypes();
    const kept = await add('Creatine', {
      doses: [{ slot: 'post', amount: '1', servings: 1, dayTypes: ['lift', 'rest'] }],
    });
    const stranded = await add('Caffeine', { doses: [{ slot: 'pre', amount: '1', servings: 1, dayTypes: ['rest'] }] });
    await ok('DELETE', `/supplements/items/${kept.id}?today=${TODAY}`);
    await ok('DELETE', `/supplements/items/${stranded.id}?today=${TODAY}`);
    await ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [DAY_TYPES[0]] });

    const stack = await ok('POST', `/supplements/items/${kept.id}/restore?today=${TODAY}`);
    const cleaned = [{ slot: 'post', amount: '1', servings: 1, dayTypes: ['lift'] }];
    expect(stack.items).toEqual([{ ...kept, doses: cleaned }]);
    expect((await changes()).slice(-2)).toEqual([
      { type: 'restored', date: TODAY, seq: 7, itemId: kept.id },
      { type: 'moved', date: TODAY, seq: 8, itemId: kept.id, doses: cleaned },
    ]);

    // Its only day type gone, the pre dose would have none.
    const res = await inject('POST', `/supplements/items/${stranded.id}/restore?today=${TODAY}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toEqual(['Caffeine: a pre dose needs at least one day type']);
    expect(await changes()).toHaveLength(8);
  });

  it('splits a mix after a day type was removed, bringing its parts back without it', async () => {
    const { ok, add, inject, changes, setDayTypes } = newUser();
    await setDayTypes();
    const dose = { slot: 'pre', amount: '1', servings: 1, dayTypes: ['lift', 'rest'] };
    const a = await add('Citrulline', { doses: [dose] });
    const b = await add('Beta-alanine', { doses: [dose] });
    const mix = await ok<SupplementCreatedResponse>('POST', `/supplements/mixes?today=${TODAY}`, { name: 'Pump', itemIds: [a.id, b.id] });

    await ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [DAY_TYPES[0]] });
    // The mix took the first part's doses; the parts' own doses were cleaned while folded.
    expect((await changes()).slice(-3).map((c) => [c.type, 'itemId' in c && c.itemId])).toEqual([
      ['moved', mix.id],
      ['moved', a.id],
      ['moved', b.id],
    ]);

    const split = await ok('POST', `/supplements/mixes/${mix.id}/split?today=${TODAY}`);
    const cleaned = [{ ...dose, dayTypes: ['lift'] }];
    expect(split.items).toEqual([
      { ...a, doses: cleaned },
      { ...b, doses: cleaned },
    ]);

    // A folded part whose workout dose would be left with no day type blocks the removal, and
    // the 400 names the mix it's in.
    const c = await add('Caffeine', { doses: [{ ...dose, dayTypes: ['lift'] }] });
    const d = await add('Taurine');
    await ok('POST', `/supplements/mixes?today=${TODAY}`, { name: 'Stim', itemIds: [d.id, c.id] });
    const res = await inject('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Stim (Caffeine): a pre dose needs at least one day type');
  });

  it('cleans the parts of a removed mix without checking them, and checks them when the mix is restored', async () => {
    const { ok, add, inject, changes, setDayTypes } = newUser();
    await setDayTypes();
    const c = await add('Caffeine', { doses: [{ slot: 'pre', amount: '1', servings: 1, dayTypes: ['lift'] }] });
    const d = await add('Taurine');
    const mix = await ok<SupplementCreatedResponse>('POST', `/supplements/mixes?today=${TODAY}`, { name: 'Stim', itemIds: [d.id, c.id] });
    await ok('DELETE', `/supplements/items/${mix.id}?today=${TODAY}`);

    // Caffeine, folded into a removed mix, can't block removing its only day type.
    await ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [DAY_TYPES[1]] });
    expect((await changes()).slice(-2)).toEqual([
      { type: 'day_types_set', date: TODAY, seq: 6, dayTypes: [DAY_TYPES[1]] },
      { type: 'moved', date: TODAY, seq: 7, itemId: c.id, doses: [{ slot: 'pre', amount: '1', servings: 1, dayTypes: [] }] },
    ]);

    // Restoring the mix brings the part back into the stack's checks, and the 400 names the mix.
    const res = await inject('POST', `/supplements/items/${mix.id}/restore?today=${TODAY}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toEqual(['Stim (Caffeine): a pre dose needs at least one day type']);
    expect(await changes()).toHaveLength(7);
  });

  it('409s restoring a part of a mix, naming the mix, and brings it back through the mix', async () => {
    const { ok, add, inject } = newUser();
    const a = await add('Citrulline');
    const b = await add('Beta-alanine');
    const mix = await ok<SupplementCreatedResponse>('POST', `/supplements/mixes?today=${TODAY}`, { name: 'Pump mix', itemIds: [a.id, b.id] });

    const inMix = await inject('POST', `/supplements/items/${a.id}/restore?today=${TODAY}`);
    expect(inMix.statusCode).toBe(409);
    expect(inMix.json()).toMatchObject({ code: SUPPLEMENT_NOT_REMOVED_CODE, message: expect.stringMatching(/"Pump mix": split the mix/) });

    await ok('DELETE', `/supplements/items/${mix.id}?today=${TODAY}`);
    const mixRemoved = await inject('POST', `/supplements/items/${a.id}/restore?today=${TODAY}`);
    expect(mixRemoved.statusCode).toBe(409);
    expect(mixRemoved.json().message).toMatch(/"Pump mix", which is removed: restore the mix, then split it/);

    await ok('POST', `/supplements/items/${mix.id}/restore?today=${TODAY}`);
    const split = await ok('POST', `/supplements/mixes/${mix.id}/split?today=${TODAY}`);
    expect(split.items).toEqual([a, b]);
  });

  it('bulk moves doses from one slot to another', async () => {
    const { ok, add, changes, setDayTypes } = newUser();
    await setDayTypes();
    const a = await add('A', { doses: [{ slot: 'am', amount: '1', servings: 1, dayTypes: [] }] });
    const b = await add('B', { doses: [{ slot: 'am', amount: '1', servings: 1, dayTypes: [] }] });
    const c = await add('C', { doses: [{ slot: 'pm', amount: '1', servings: 1, dayTypes: [] }] });

    const stack = await ok('POST', `/supplements/doses/move?today=${TODAY}`, {
      itemIds: [a.id, b.id, c.id],
      from: 'am',
      to: 'post',
      dayTypes: ['lift'],
    });
    expect(stack.items.map((i) => i.doses[0]?.slot)).toEqual(['post', 'post', 'pm']);
    expect((await changes()).slice(4).map((ch) => [ch.type, 'itemId' in ch && ch.itemId])).toEqual([
      ['moved', a.id],
      ['moved', b.id],
    ]);
  });

  it('bulk marks items pending and active', async () => {
    const { ok, add, changes } = newUser();
    const a = await add('A');
    const b = await add('B', { status: 'pending' });
    const stack = await ok('POST', `/supplements/items/status?today=${TODAY}`, { itemIds: [a.id, b.id], status: 'pending' });
    expect(stack.items.map((i) => i.status)).toEqual(['pending', 'pending']);
    await ok('POST', `/supplements/items/status?today=${TODAY}`, { itemIds: [a.id, b.id], status: 'active' });
    expect((await changes()).slice(2).map((ch) => ch.type)).toEqual(['moved_to_pending', 'started', 'started']);
  });

  it('combines items into a mix in the first one’s place, returns its id, and splits it back', async () => {
    const { ok, add, inject, changes } = newUser();
    const a = await add('Citrulline', { ingredients: [{ key: 'citrulline', amount: 6, unit: 'g' }] });
    const b = await add('Beta-alanine', { ingredients: [{ key: 'beta-alanine', amount: 3.2, unit: 'g' }] });
    const c = await add('Fish oil');

    const mixed = await ok<SupplementCreatedResponse>('POST', `/supplements/mixes?today=${TODAY}`, {
      name: 'Pump mix',
      itemIds: [b.id, a.id],
    });
    expect(mixed.items.map((i) => i.name)).toEqual(['Pump mix', 'Fish oil']);
    const mix = mixed.items[0];
    expect(mix?.id).toBe(mixed.id);
    expect(mix?.parts).toEqual([
      { itemId: b.id, name: b.name, ingredients: b.ingredients },
      { itemId: a.id, name: a.name, ingredients: a.ingredients },
    ]);
    expect((await changes()).slice(-1)[0]).toEqual({ type: 'mix_created', date: TODAY, seq: 4, mix, partIds: [b.id, a.id] });

    expect((await inject('POST', `/supplements/mixes/${c.id}/split?today=${TODAY}`)).statusCode).toBe(400);
    const split = await ok('POST', `/supplements/mixes/${mixed.id}/split?today=${TODAY}`);
    expect(split.items).toEqual([b, a, c]);
    expect((await changes()).slice(-1)[0]).toEqual({ type: 'mix_split', date: TODAY, seq: 5, mixId: mixed.id });
  });

  it('reads the stack as of a date by replaying the log, with the first change date', async () => {
    const { ok, asOf, inject } = newUser();
    await ok('POST', '/supplements/items?today=2026-11-01', { name: 'Old' });
    const recent = await ok<SupplementCreatedResponse>('POST', '/supplements/items?today=2026-11-10', { name: 'New' });
    await ok('DELETE', `/supplements/items/${recent.id}?today=2026-11-15`);

    const names = async (date: string) => (await asOf(date)).items.map((i) => i.name);
    expect(await names('2026-10-31')).toEqual([]);
    expect(await names('2026-11-10')).toEqual(['Old', 'New']);
    expect(await names('2026-11-15')).toEqual(['Old']);
    expect(await asOf('2026-10-31')).toEqual({ items: [], firstChangeDate: '2026-11-01', anomalies: [] });
    expect((await inject('GET', '/supplements/as-of/2026-02-30')).statusCode).toBe(400);
  });

  it('pages the change log back from a seq', async () => {
    const { add, inject } = newUser();
    for (const name of ['A', 'B', 'C', 'D', 'E']) await add(name);
    const page = async (query: string) =>
      (await inject('GET', `/supplements/changes${query}`)).json<SupplementChange[]>().map((c) => c.seq);
    expect(await page('')).toEqual([1, 2, 3, 4, 5]);
    expect(await page('?limit=2')).toEqual([4, 5]);
    expect(await page('?limit=2&beforeSeq=4')).toEqual([2, 3]);
    expect(await page('?limit=2&beforeSeq=2')).toEqual([1]);
    for (const bad of ['?limit=0', '?limit=1001', '?limit=x', '?beforeSeq=0', '?beforeSeq=-1', '?beforeSeq=2147483648']) {
      expect([bad, (await inject('GET', `/supplements/changes${bad}`)).statusCode]).toEqual([bad, 400]);
    }
    // The largest seq the log's integer column holds is still a page boundary.
    expect(await page('?beforeSeq=2147483647')).toEqual([1, 2, 3, 4, 5]);
  });
});
