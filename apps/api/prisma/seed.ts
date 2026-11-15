import { PrismaClient } from '@prisma/client';
import { SEED_USER_ID, buildSeedPlan, writeSeedPlan } from './seed-plan';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding staging database...');
  const plan = buildSeedPlan(new Date());
  await writeSeedPlan(prisma, plan);

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
