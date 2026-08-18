import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_USER_ID = 'seed_user_clerkid_staging_001';
const PROGRAM = '531';

const LIFTS = [
  { name: 'squat',              startMax: 225, increment: 5,   muscles: ['quads', 'glutes', 'hamstrings'] },
  { name: 'deadlift',           startMax: 275, increment: 5,   muscles: ['hamstrings', 'glutes', 'back'] },
  { name: 'bench-press',        startMax: 185, increment: 2.5, muscles: ['chest', 'triceps', 'shoulders'] },
  { name: 'overhead-press',     startMax: 115, increment: 2.5, muscles: ['shoulders', 'triceps'] },
  { name: 'barbell-row',        startMax: 165, increment: 2.5, muscles: ['back', 'biceps'] },
  { name: 'romanian-deadlift',  startMax: 185, increment: 5,   muscles: ['hamstrings', 'glutes'] },
];

// 5/3/1 week types and their set percentages (of training max)
const WEEK_TYPES = [
  { weekType: 'A', pct: [0.65, 0.75, 0.85] },
  { weekType: 'B', pct: [0.70, 0.80, 0.90] },
  { weekType: 'C', pct: [0.75, 0.85, 0.95] },
];

// Workouts per cycle: 3 workouts, each hits 2 lifts
const WORKOUT_LIFTS: Record<number, string[]> = {
  1: ['squat', 'bench-press'],
  2: ['deadlift', 'overhead-press'],
  3: ['barbell-row', 'romanian-deadlift'],
};

const NUM_CYCLES = 12;
const DAYS_PER_WORKOUT = 2; // workouts every other day

function trainingMaxAt(lift: typeof LIFTS[0], cycle: number): number {
  return lift.startMax + lift.increment * cycle;
}

function weightForSet(max: number, pct: number): number {
  // Round to nearest 2.5 lb plate
  return Math.round((max * pct) / 2.5) * 2.5;
}

async function main() {
  console.log('Seeding staging database...');

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - NUM_CYCLES * 3 * DAYS_PER_WORKOUT);

  // UserSettings
  await prisma.userSettings.upsert({
    where: { userId: SEED_USER_ID },
    update: {},
    create: {
      userId: SEED_USER_ID,
      activeProgram: PROGRAM,
      workoutSchedule: { days: ['Monday', 'Wednesday', 'Friday'] },
    },
  });

  // LiftMetadata
  for (const lift of LIFTS) {
    await prisma.liftMetadata.upsert({
      where: { userId_lift: { userId: SEED_USER_ID, lift: lift.name } },
      update: {},
      create: {
        userId: SEED_USER_ID,
        lift: lift.name,
        muscleGroups: lift.muscles,
        substitutions: [],
        foundational: true,
      },
    });
  }

  // TrainingMax (current — after all cycles)
  for (const lift of LIFTS) {
    const currentMax = trainingMaxAt(lift, NUM_CYCLES);
    await prisma.trainingMax.upsert({
      where: { userId_program_lift: { userId: SEED_USER_ID, program: PROGRAM, lift: lift.name } },
      update: { weight: currentMax, dateUpdated: now },
      create: {
        userId: SEED_USER_ID,
        program: PROGRAM,
        lift: lift.name,
        weight: currentMax,
        dateUpdated: now,
      },
    });
  }

  // TrainingMaxHistory + LiftRecords
  const workoutDate = new Date(startDate);

  // LiftRecord has no single-field unique key to upsert on, and `workoutDate`
  // below is recomputed from `new Date()` each run — so a naive re-run would
  // insert a fresh duplicate row set every time once `date` joined the
  // natural-key unique constraint (issue #884). Wipe this program's lift
  // records first so the loop below can use a plain `create` and stay
  // idempotent across repeated seed runs.
  await prisma.liftRecord.deleteMany({ where: { userId: SEED_USER_ID, program: PROGRAM } });

  for (let cycle = 0; cycle < NUM_CYCLES; cycle++) {
    const weekType = WEEK_TYPES[cycle % 3];
    if (!weekType) throw new Error(`WEEK_TYPES missing index ${cycle % 3}`);
    const cycleNum = cycle + 1;

    // TrainingMaxHistory — one entry per lift at cycle start (representing a PR test)
    if (cycle > 0 && cycle % 3 === 0) {
      for (const lift of LIFTS) {
        const weight = trainingMaxAt(lift, cycle);
        const histDate = new Date(workoutDate);
        await prisma.trainingMaxHistory.upsert({
          where: {
            // No single unique index — use create only if not exists by checking
            id: `seed-tmh-${SEED_USER_ID}-${PROGRAM}-${lift.name}-cycle${cycle}`,
          },
          update: {},
          create: {
            id: `seed-tmh-${SEED_USER_ID}-${PROGRAM}-${lift.name}-cycle${cycle}`,
            userId: SEED_USER_ID,
            program: PROGRAM,
            lift: lift.name,
            weight,
            reps: 1,
            date: histDate,
            isPR: true,
            source: 'test',
            goalMet: false,
          },
        });
      }
    }

    for (let workoutNum = 1; workoutNum <= 3; workoutNum++) {
      const liftsThisWorkout = WORKOUT_LIFTS[workoutNum];
      if (!liftsThisWorkout) throw new Error(`WORKOUT_LIFTS missing entry for workout ${workoutNum}`);

      for (const liftName of liftsThisWorkout) {
        const lift = LIFTS.find((l) => l.name === liftName);
        if (!lift) throw new Error(`LIFTS missing entry for ${liftName}`);
        const max = trainingMaxAt(lift, cycle);

        for (let setNum = 1; setNum <= 3; setNum++) {
          const pct = weekType.pct[setNum - 1];
          // Explicit undefined check — 0 would be a valid (if degenerate) percentage,
          // so !pct would be incorrect here even though the other guards in this file use it.
          if (pct === undefined) throw new Error(`weekType.pct missing index ${setNum - 1}`);
          const weight = weightForSet(max, pct);
          const isAmrap = setNum === 3;
          const amrapReps = isAmrap ? 5 + ((cycle * workoutNum + setNum) % 4) : 5;

          // Plain create, not upsert: the table was wiped for this program above,
          // so every row here is guaranteed new (see comment at the wipe site).
          await prisma.liftRecord.create({
            data: {
              userId: SEED_USER_ID,
              program: PROGRAM,
              cycleNum,
              workoutNum,
              date: new Date(workoutDate),
              lift: liftName,
              setNum,
              weight,
              reps: amrapReps,
              notes: isAmrap ? 'AMRAP set' : '',
            },
          });
        }
      }

      workoutDate.setDate(workoutDate.getDate() + DAYS_PER_WORKOUT);
    }
  }

  // CycleDashboard — current cycle state
  const currentCycle = NUM_CYCLES;
  await prisma.cycleDashboard.upsert({
    where: { userId_program: { userId: SEED_USER_ID, program: PROGRAM } },
    update: {
      cycleNum: currentCycle,
      cycleDate: now,
    },
    create: {
      userId: SEED_USER_ID,
      program: PROGRAM,
      cycleUnit: 'cycle',
      cycleNum: currentCycle,
      cycleDate: now,
      sheetName: '531',
      cycleStartWeekday: 'Monday',
      programType: '531',
    },
  });

  // StrengthGoals — one per lift (relative, bodyweight ratio targets)
  const GOAL_RATIOS = new Map<string, number>([
    ['squat', 1.5],
    ['deadlift', 2.0],
    ['bench-press', 1.25],
    ['overhead-press', 0.75],
    ['barbell-row', 1.0],
    ['romanian-deadlift', 1.25],
  ]);
  for (const lift of LIFTS) {
    await prisma.strengthGoal.upsert({
      where: { userId_program_lift: { userId: SEED_USER_ID, program: PROGRAM, lift: lift.name } },
      update: {},
      create: {
        userId: SEED_USER_ID,
        program: PROGRAM,
        lift: lift.name,
        goalType: 'relative',
        unit: 'lbs',
        ratio: GOAL_RATIOS.get(lift.name) ?? null,
      },
    });
  }

  console.log(`Seeding complete.`);
  console.log(`  UserSettings:        1`);
  console.log(`  LiftMetadata:        ${LIFTS.length}`);
  console.log(`  TrainingMax:         ${LIFTS.length}`);
  console.log(`  TrainingMaxHistory:  ${Math.floor(NUM_CYCLES / 3) * LIFTS.length}`);
  console.log(`  CycleDashboard:      1`);
  console.log(`  StrengthGoal:        ${LIFTS.length}`);
  console.log(`  LiftRecord:          ${NUM_CYCLES * 3 * 2 * 3} (approx)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
