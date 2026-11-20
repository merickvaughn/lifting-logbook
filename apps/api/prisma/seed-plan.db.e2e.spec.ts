// Real-Postgres E2E for the staging seed's write (#1022): runs `writeSeedPlan` twice as the
// restricted lifting_app role, which row-level security applies to, against rows an earlier
// seed left under names the app doesn't resolve. Postgres is provisioned by jest.global-setup.js
// (Testcontainers locally; CI passthrough).
import { PrismaClient } from '@prisma/client';
import { PROGRAM, SEED_USER_ID, buildSeedPlan, writeSeedPlan } from './seed-plan';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const APP_URL = APP_ROLE_URL ?? '';
const OWNER_URL = OWNER_DATABASE_URL ?? '';

// See rls.db.e2e.spec.ts: a contended Windows run can pass Jest's 5s defaults (#567, #1329).
const DB_E2E_TIMEOUT_MS = 60_000;

const OTHER = 'seed-plan-e2e-other-user';

describeOrSkip('Staging seed write (#1022, e2e, lifting_app role)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;

  const clean = async () => {
    await owner.trainingMax.deleteMany({ where: { userId: { in: [SEED_USER_ID, OTHER] } } });
    await owner.liftMetadata.deleteMany({ where: { userId: SEED_USER_ID } });
    await owner.userSettings.deleteMany({ where: { userId: SEED_USER_ID } });
    await owner.liftRecord.deleteMany({ where: { userId: SEED_USER_ID } });
    await owner.trainingMaxHistory.deleteMany({ where: { userId: SEED_USER_ID } });
    await owner.strengthGoal.deleteMany({ where: { userId: SEED_USER_ID } });
    await owner.macrocycle.deleteMany({ where: { userId: SEED_USER_ID } });
    await owner.macrocycleDashboard.deleteMany({ where: { userId: SEED_USER_ID } });
    await owner.supplementChange.deleteMany({ where: { userId: SEED_USER_ID } });
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
    await app.$connect();
    await clean();
  }, DB_E2E_TIMEOUT_MS);

  afterAll(async () => {
    await clean().catch(() => undefined);
    await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
  }, DB_E2E_TIMEOUT_MS);

  it('runs as the restricted role', async () => {
    const rows = await app.$queryRaw<Array<{ role: string; rolbypassrls: boolean }>>`
      SELECT current_user::text AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ role: 'lifting_app', rolbypassrls: false }]);
  });

  it(
    "replaces an earlier seed's rows, twice over, and leaves other users alone",
    async () => {
      // What the seed wrote before #1022, plus another user's row the reset must not touch.
      await owner.userSettings.create({ data: { userId: SEED_USER_ID, activeProgram: '531' } });
      await owner.liftMetadata.create({
        data: { userId: SEED_USER_ID, lift: 'squat', muscleGroups: ['quads', 'back'], substitutions: [], foundational: true },
      });
      await owner.trainingMax.createMany({
        data: [
          { userId: SEED_USER_ID, program: '531', lift: 'squat', weight: 285, dateUpdated: new Date() },
          { userId: OTHER, program: PROGRAM, lift: 'Squat', weight: 300, dateUpdated: new Date() },
        ],
      });

      const plan = buildSeedPlan(new Date());
      await writeSeedPlan(app, plan);
      await writeSeedPlan(app, plan);

      const where = { userId: SEED_USER_ID };
      expect(await owner.liftMetadata.count({ where })).toBe(0);
      expect(await owner.userSettings.findUnique({ where })).toMatchObject({ activeProgram: PROGRAM });
      const seededMaxes = await owner.trainingMax.findMany({ where });
      expect(seededMaxes.map((m) => `${m.program}|${m.lift}`).sort()).toEqual(
        plan.trainingMaxes.map((m) => `${m.program}|${m.lift}`).sort(),
      );
      expect(await owner.liftRecord.count({ where })).toBe(plan.liftRecords.length);
      expect(await owner.trainingMaxHistory.count({ where })).toBe(plan.trainingMaxHistory.length);
      expect(await owner.macrocycle.count({ where })).toBe(plan.macrocycles.length);
      expect(await owner.macrocycleDashboard.count({ where })).toBe(1);
      expect(await owner.strengthGoal.count({ where })).toBe(plan.strengthGoals.length);
      expect(await owner.trainingMax.count({ where: { userId: OTHER } })).toBe(1);
    },
    DB_E2E_TIMEOUT_MS,
  );

  it(
    'keeps the supplement log and the caffeine cutoff it records across a re-seed (#1374)',
    async () => {
      await writeSeedPlan(app, buildSeedPlan(new Date()));
      await owner.userSettings.update({ where: { userId: SEED_USER_ID }, data: { supplementCaffeineCutoff: '12:00' } });
      await owner.supplementChange.create({
        data: { userId: SEED_USER_ID, seq: 1, date: new Date('2026-11-20'), type: 'caffeine_cutoff_set', payload: { caffeineCutoff: '12:00' } },
      });

      const plan = buildSeedPlan(new Date());
      await writeSeedPlan(app, plan);
      await writeSeedPlan(app, plan);

      const where = { userId: SEED_USER_ID };
      expect(await owner.userSettings.findUnique({ where })).toMatchObject({ activeProgram: PROGRAM, supplementCaffeineCutoff: '12:00' });
      expect((await owner.supplementChange.findMany({ where })).map((c) => c.type)).toEqual(['caffeine_cutoff_set']);
    },
    DB_E2E_TIMEOUT_MS,
  );
});
