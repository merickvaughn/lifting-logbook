import { PrismaClient } from '@prisma/client';
import { SEED_USER_ID, buildSeedPlan, resetSeedUser } from './seed-plan';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding staging database...');
  const plan = buildSeedPlan(new Date());

  // One transaction, so a failed run leaves the seed user as it was. Each run deletes the
  // seed user's rows and writes the plan again, rather than upserting around rows an
  // earlier version of this seed wrote under names the app doesn't resolve (#1022).
  await prisma.$transaction(
    async (tx) => {
      // Row-level security admits only this user's rows, for a role it applies to (issue #511).
      // A role that bypasses it, like the migrator's, ignores the setting.
      await tx.$queryRaw`SELECT set_config('app.current_user_id', ${SEED_USER_ID}, true)`;
      await resetSeedUser(tx);
      await tx.userSettings.create({ data: plan.userSettings });
      await tx.macrocycle.createMany({ data: plan.macrocycles });
      await tx.macrocycleDashboard.create({ data: plan.dashboard });
      await tx.trainingMax.createMany({ data: plan.trainingMaxes });
      await tx.trainingMaxHistory.createMany({ data: plan.trainingMaxHistory });
      await tx.liftRecord.createMany({ data: plan.liftRecords });
      await tx.strengthGoal.createMany({ data: plan.strengthGoals });
    },
    { timeout: 60_000 },
  );

  console.log(`Seeding complete for ${SEED_USER_ID} (program ${plan.userSettings.activeProgram}).`);
  console.log(`  UserSettings:        1`);
  console.log(`  Macrocycle:          ${plan.macrocycles.length}`);
  console.log(`  MacrocycleDashboard: 1 (macrocycle ${plan.dashboard.macrocycleNum})`);
  console.log(`  TrainingMax:         ${plan.trainingMaxes.length}`);
  console.log(`  TrainingMaxHistory:  ${plan.trainingMaxHistory.length}`);
  console.log(`  LiftRecord:          ${plan.liftRecords.length}`);
  console.log(`  StrengthGoal:        ${plan.strengthGoals.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
