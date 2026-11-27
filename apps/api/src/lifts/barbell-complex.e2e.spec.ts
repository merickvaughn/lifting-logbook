import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { BarbellComplexResponse } from '@lifting-logbook/types';
import { AppModule } from '../app.module';
import { DomainConflictFilter } from '../programs/conflict.filter';
import { DomainNotFoundFilter } from '../programs/not-found.filter';
import { injectPage } from '../testing/macrocycle-id';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const BEAR_COMPONENTS = [
  { lift: 'Deadlift', reps: 5 },
  { lift: 'Front Squat', reps: 5 },
  { lift: 'Push Press', reps: 5 },
];

describe('Barbell complexes HTTP (e2e, in-memory adapters, #1495)', () => {
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

  /** Each test takes its own user, since the in-memory factory keeps a bundle per user. */
  const as = (user: string) => (method: string, url: string, body?: unknown) =>
    injectPage(app, {
      method: method as 'GET',
      url,
      headers:
        body === undefined
          ? { authorization: `Bearer ${user}` }
          : { 'content-type': 'application/json', authorization: `Bearer ${user}` },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  async function create(request: ReturnType<typeof as>, name: string): Promise<BarbellComplexResponse> {
    const res = await request('POST', '/lifts/complexes', { name, components: BEAR_COMPONENTS });
    expect(res.statusCode).toBe(201);
    return res.json() as BarbellComplexResponse;
  }

  it('creates, lists, updates and deletes a complex, keeping its components in order', async () => {
    const user = as('complex-crud');
    const created = await create(user, '  Bear  ');
    expect(created).toMatchObject({ name: 'Bear', components: BEAR_COMPONENTS });
    expect(created).not.toHaveProperty('userId');

    const listed = (await user('GET', '/lifts/complexes')).json() as BarbellComplexResponse[];
    expect(listed).toEqual([created]);

    const reordered = [
      { lift: 'Front Squat', reps: 3 },
      { lift: 'Deadlift', reps: 2 },
    ];
    const updated = await user('PATCH', `/lifts/complexes/${created.id}`, { name: 'Mini bear', components: reordered });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: created.id, name: 'Mini bear', components: reordered });

    const renamedOnly = await user('PATCH', `/lifts/complexes/${created.id}`, { name: 'Bear' });
    expect(renamedOnly.json()).toMatchObject({ name: 'Bear', components: reordered });

    expect((await user('DELETE', `/lifts/complexes/${created.id}`)).statusCode).toBe(204);
    expect((await user('GET', '/lifts/complexes')).json()).toEqual([]);
  });

  it('answers 409 for a name the user already has, on create and on rename', async () => {
    const user = as('complex-conflict');
    await create(user, 'Bear');
    const other = await create(user, 'Clean complex');
    expect((await user('POST', '/lifts/complexes', { name: 'Bear', components: BEAR_COMPONENTS })).statusCode).toBe(409);
    expect((await user('PATCH', `/lifts/complexes/${other.id}`, { name: 'Bear' })).statusCode).toBe(409);
  });

  it('answers 404 for an unknown id', async () => {
    const user = as('complex-not-found');
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await user('PATCH', `/lifts/complexes/${missing}`, { name: 'Bear' })).statusCode).toBe(404);
    expect((await user('DELETE', `/lifts/complexes/${missing}`)).statusCode).toBe(404);
  });

  it("keeps one user's complexes from another", async () => {
    const owner = as('complex-owner');
    const intruder = as('complex-intruder');
    const created = await create(owner, 'Bear');
    expect((await intruder('GET', '/lifts/complexes')).json()).toEqual([]);
    expect((await intruder('PATCH', `/lifts/complexes/${created.id}`, { name: 'Mine' })).statusCode).toBe(404);
    expect((await intruder('DELETE', `/lifts/complexes/${created.id}`)).statusCode).toBe(404);
    // And a name is only taken per user.
    await create(intruder, 'Bear');
  });

  it('accepts any spelling of a lift and a custom lift, and refuses a name that is no lift', async () => {
    const user = as('complex-lifts');
    const custom = await user('POST', '/lifts/custom', { name: 'Hang Snatch Pull', classification: 'compound' });
    expect(custom.statusCode).toBe(201);
    const res = await user('POST', '/lifts/complexes', {
      name: 'Snatch complex',
      components: [
        { lift: 'bench-press', reps: 3 },
        { lift: 'Hang Snatch Pull', reps: 3 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as BarbellComplexResponse).components.map((c) => c.lift)).toEqual(['bench-press', 'Hang Snatch Pull']);

    const unknown = await user('POST', '/lifts/complexes', {
      name: 'Nonsense',
      components: [
        { lift: 'Squat', reps: 5 },
        { lift: 'Underwater Basket Weaving', reps: 5 },
      ],
    });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { message: string }).message).toBe("'Underwater Basket Weaving' is not a lift");
  });

  describe('validation', () => {
    const component = { lift: 'Squat', reps: 5 };
    it.each([
      ['a blank name', { name: '   ', components: [component, component] }],
      ['a name over 100 characters', { name: 'x'.repeat(101), components: [component, component] }],
      ['one component', { name: 'Short', components: [component] }],
      ['eleven components', { name: 'Long', components: Array(11).fill(component) }],
      ['zero reps', { name: 'Zero', components: [component, { lift: 'Squat', reps: 0 }] }],
      ['101 reps', { name: 'Many', components: [component, { lift: 'Squat', reps: 101 }] }],
      ['fractional reps', { name: 'Half', components: [component, { lift: 'Squat', reps: 2.5 }] }],
      ['a blank lift', { name: 'Blank', components: [component, { lift: ' ', reps: 5 }] }],
      ['an undeclared field', { name: 'Extra', components: [component, component], weight: 95 }],
    ])('refuses %s with a 400', async (_label, body) => {
      const res = await as('complex-validation')('POST', '/lifts/complexes', body);
      expect(res.statusCode).toBe(400);
    });

    it('refuses a null name or components on update', async () => {
      const user = as('complex-validation-update');
      const created = await create(user, 'Bear');
      expect((await user('PATCH', `/lifts/complexes/${created.id}`, { name: null })).statusCode).toBe(400);
      expect((await user('PATCH', `/lifts/complexes/${created.id}`, { components: null })).statusCode).toBe(400);
      expect((await user('PATCH', `/lifts/complexes/${created.id}`, { components: [component] })).statusCode).toBe(400);
    });
  });
});
