import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SupplementChange, SupplementItem, SupplementStackResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const TODAY = '2026-11-20';
const DAY_TYPES = [
  { id: 'lift', name: 'Lift day', sessionTime: '17:00' },
  { id: 'rest', name: 'Rest day' },
];

describe('Supplements HTTP (e2e, in-memory adapters)', () => {
  let app: NestFastifyApplication;
  let userCount = 0;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
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
    const inject = (method: string, url: string, body?: unknown) =>
      app.inject({
        method: method as 'GET',
        url,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const ok = async (method: string, url: string, body?: unknown): Promise<SupplementStackResponse> => {
      const res = await inject(method, url, body);
      expect([200, 201]).toContain(res.statusCode);
      return res.json() as SupplementStackResponse;
    };
    const add = async (name: string, extra: Record<string, unknown> = {}): Promise<SupplementItem> => {
      const stack = await ok('POST', `/supplements/items?today=${TODAY}`, { name, ...extra });
      return stack.items.find((i) => i.name === name) as SupplementItem;
    };
    const changes = async () => (await inject('GET', '/supplements/changes')).json() as SupplementChange[];
    return { inject, ok, add, changes };
  }

  it('lists an empty stack with the default caffeine cutoff', async () => {
    const { ok } = newUser();
    expect(await ok('GET', '/supplements')).toEqual({ items: [], dayTypes: [], caffeineCutoff: '14:00' });
  });

  it('creates an item with its doses and logs it as added', async () => {
    const { ok, add, changes } = newUser();
    await ok('PUT', '/supplements/settings', { dayTypes: DAY_TYPES });
    const item = await add('Creatine', {
      ingredients: [{ key: 'creatine', amount: 5, unit: 'g' }],
      doses: [{ slot: 'post', amount: '1 scoop', servings: 1, dayTypes: ['lift'] }],
    });
    expect(item).toMatchObject({ name: 'Creatine', status: 'active', unverified: false, doses: [{ slot: 'post' }] });
    expect(await changes()).toEqual([{ type: 'added', date: TODAY, seq: 1, item }]);
  });

  it('rejects a workout-slot dose with no day type, and logs nothing', async () => {
    const { inject, changes } = newUser();
    const res = await inject('POST', '/supplements/items', {
      name: 'Caffeine',
      doses: [{ slot: 'pre', amount: '', servings: 1, dayTypes: [] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toEqual(['Caffeine: a pre dose needs at least one day type']);
    expect(await changes()).toEqual([]);
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

  it('404s an update to an item the user does not have', async () => {
    const { inject } = newUser();
    expect((await inject('PATCH', '/supplements/items/nope', { name: 'x' })).statusCode).toBe(404);
  });

  it('removes an item, restores it from the log, and 409s a second restore', async () => {
    const { ok, add, inject, changes } = newUser();
    const item = await add('Ashwagandha', { longNote: 'KSM-66' });
    expect((await ok('DELETE', `/supplements/items/${item.id}?today=${TODAY}`)).items).toEqual([]);
    expect((await changes())[1]).toEqual({ type: 'removed', date: TODAY, seq: 2, item });

    expect((await ok('POST', `/supplements/items/${item.id}/restore?today=${TODAY}`)).items).toEqual([item]);
    expect((await changes())[2]).toEqual({ type: 'restored', date: TODAY, seq: 3, itemId: item.id });

    const again = await inject('POST', `/supplements/items/${item.id}/restore`);
    expect(again.statusCode).toBe(409);
    expect(await changes()).toHaveLength(3);
  });

  it('404s restoring an item that was never removed', async () => {
    const { inject } = newUser();
    expect((await inject('POST', '/supplements/items/nope/restore')).statusCode).toBe(404);
  });

  it('sets the caffeine cutoff and day types, taking a removed day type off every dose', async () => {
    const { ok, add, changes } = newUser();
    await ok('PUT', '/supplements/settings', { dayTypes: DAY_TYPES, caffeineCutoff: '13:30' });
    const item = await add('Electrolytes', { doses: [{ slot: 'all', amount: '1', servings: 1, dayTypes: ['lift', 'rest'] }] });

    const stack = await ok('PUT', `/supplements/settings?today=${TODAY}`, { dayTypes: [DAY_TYPES[0]] });
    expect(stack.caffeineCutoff).toBe('13:30');
    expect(stack.dayTypes).toEqual([DAY_TYPES[0]]);
    expect(stack.items[0]?.doses[0]?.dayTypes).toEqual(['lift']);
    expect((await changes()).slice(-1)[0]).toEqual({
      type: 'moved',
      date: TODAY,
      seq: 2,
      itemId: item.id,
      doses: [{ slot: 'all', amount: '1', servings: 1, dayTypes: ['lift'] }],
    });
  });

  it('400s removing the only day type of a workout-slot dose, and saves nothing', async () => {
    const { ok, add, inject, changes } = newUser();
    await ok('PUT', '/supplements/settings', { dayTypes: DAY_TYPES });
    await add('Pre-workout', { doses: [{ slot: 'pre', amount: '1 scoop', servings: 1, dayTypes: ['lift'] }] });

    const res = await inject('PUT', '/supplements/settings', { dayTypes: [DAY_TYPES[1]] });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toEqual(['Pre-workout: a pre dose needs at least one day type']);
    expect((await ok('GET', '/supplements')).dayTypes).toEqual(DAY_TYPES);
    expect(await changes()).toHaveLength(1);
  });

  it('bulk moves doses from one slot to another', async () => {
    const { ok, add, changes } = newUser();
    await ok('PUT', '/supplements/settings', { dayTypes: DAY_TYPES });
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
    expect((await changes()).slice(3).map((ch) => [ch.type, 'itemId' in ch && ch.itemId])).toEqual([
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
    await ok('POST', '/supplements/items/status', { itemIds: [a.id, b.id], status: 'active' });
    expect((await changes()).slice(2).map((ch) => ch.type)).toEqual(['moved_to_pending', 'started', 'started']);
  });

  it('combines items into a mix and splits it back', async () => {
    const { ok, add, inject, changes } = newUser();
    const a = await add('Citrulline', { ingredients: [{ key: 'citrulline', amount: 6, unit: 'g' }] });
    const b = await add('Beta-alanine', { ingredients: [{ key: 'beta-alanine', amount: 3.2, unit: 'g' }] });
    const c = await add('Fish oil');

    const mixed = await ok('POST', `/supplements/mixes?today=${TODAY}`, { name: 'Pump mix', itemIds: [a.id, b.id] });
    expect(mixed.items.map((i) => i.name)).toEqual(['Pump mix', 'Fish oil']);
    const mix = mixed.items[0] as SupplementItem;
    expect(mix.parts).toEqual([
      { itemId: a.id, name: a.name, ingredients: a.ingredients },
      { itemId: b.id, name: b.name, ingredients: b.ingredients },
    ]);
    expect((await changes()).slice(-1)[0]).toEqual({ type: 'mix_created', date: TODAY, seq: 4, mix, partIds: [a.id, b.id] });

    expect((await inject('POST', `/supplements/mixes/${c.id}/split`)).statusCode).toBe(400);
    const split = await ok('POST', `/supplements/mixes/${mix.id}/split?today=${TODAY}`);
    expect(split.items).toEqual([a, b, c]);
    expect((await changes()).slice(-1)[0]).toEqual({ type: 'mix_split', date: TODAY, seq: 5, mixId: mix.id });
  });

  it('reads the stack as of a date by replaying the log', async () => {
    const { ok, inject } = newUser();
    await ok('POST', '/supplements/items?today=2026-11-01', { name: 'Old' });
    const recent = (await ok('POST', '/supplements/items?today=2026-11-10', { name: 'New' })).items[1] as SupplementItem;
    await ok('DELETE', `/supplements/items/${recent.id}?today=2026-11-15`);

    const names = async (date: string) =>
      ((await inject('GET', `/supplements/as-of/${date}`)).json() as { items: SupplementItem[] }).items.map((i) => i.name);
    expect(await names('2026-10-31')).toEqual([]);
    expect(await names('2026-11-10')).toEqual(['Old', 'New']);
    expect(await names('2026-11-15')).toEqual(['Old']);
    expect((await inject('GET', '/supplements/as-of/2026-02-30')).statusCode).toBe(400);
  });
});
