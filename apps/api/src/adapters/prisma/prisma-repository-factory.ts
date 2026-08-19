import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AuthUser } from '../../ports/auth';
import { IRepositoryFactory, RepositoryBundle } from '../../ports/factory';
import { PrismaService } from './prisma.service';
import { RLS_TX_CLIENT } from './rls-context';
import { PrismaBodyWeightRepository } from './body-weight.repository';
import { PrismaCustomLiftRepository } from './custom-lift.repository';
import { PrismaCycleDashboardRepository } from './cycle-dashboard.repository';
import { PrismaCycleScheduledWorkoutRepository } from './cycle-scheduled-workout.repository';
import { PrismaImportBatchRepository } from './import-batch.repository';
import { PrismaLiftMetadataRepository } from './lift-metadata.repository';
import { PrismaLiftRecordRepository } from './lift-record.repository';
import { PrismaStrengthGoalRepository } from './strength-goal.repository';
import { PrismaTrainingMaxRepository } from './training-max.repository';
import { PrismaTrainingMaxHistoryRepository } from './training-max-history.repository';
import { PrismaWorkoutDateOverrideRepository } from './workout-date-override.repository';
import { PrismaWorkoutLiftOverrideRepository } from './workout-lift-override.repository';
import { PrismaWorkoutSkipOverrideRepository } from './workout-skip-override.repository';
import { PrismaWorkoutRepository } from './workout.repository';
import { HybridLiftingProgramSpecRepository } from './hybrid-program-spec.repository';
import { InMemoryProgramPhilosophyRepository } from '../in-memory/program-philosophy.adapter';
import { InMemoryLiftingProgramSpecRepository } from '../in-memory/lifting-program-spec.adapter';
import { UserSettingsRepository } from '../../user-settings/user-settings.repository';

@Injectable()
export class PrismaRepositoryFactory implements IRepositoryFactory {
  // Built-in program philosophy is user-independent, so it can be a singleton. The
  // spec repo's custom-program branch must be scoped to the requesting user, so a
  // thin per-user wrapper is built in forUser() — but its built-in spec data is
  // global, so the in-memory delegate is shared here rather than rebuilt (and
  // re-seeded) on every request.
  private readonly philosophyRepo = new InMemoryProgramPhilosophyRepository();
  private readonly inMemorySpecRepo = new InMemoryLiftingProgramSpecRepository();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  // Per request, RlsInterceptor opens a transaction (with app.current_user_id set) and stashes
  // its transaction client in CLS. Routing every repository through that client keeps the RLS GUC
  // in scope for all of the request's queries. Outside a request (no active CLS context) the base
  // client is used — repositories then run with no GUC, which is fail-closed against userId tables.
  private client(): PrismaClient {
    const tx = this.cls.isActive()
      ? (this.cls.get(RLS_TX_CLIENT) as PrismaClient | undefined)
      : undefined;
    return tx ?? this.prisma;
  }

  async forUser(user: AuthUser): Promise<RepositoryBundle> {
    const db = this.client();
    return {
      bodyWeight: new PrismaBodyWeightRepository(db, user.id),
      customLift: new PrismaCustomLiftRepository(db, user.id),
      cycleDashboard: new PrismaCycleDashboardRepository(db, user.id),
      cycleScheduledWorkout: new PrismaCycleScheduledWorkoutRepository(db, user.id),
      importBatch: new PrismaImportBatchRepository(db, user.id),
      liftMetadata: new PrismaLiftMetadataRepository(db, user.id),
      liftRecord: new PrismaLiftRecordRepository(db, user.id),
      programPhilosophy: this.philosophyRepo,
      strengthGoal: new PrismaStrengthGoalRepository(db, user.id),
      trainingMax: new PrismaTrainingMaxRepository(db, user.id),
      trainingMaxHistory: new PrismaTrainingMaxHistoryRepository(db, user.id),
      userSettings: new UserSettingsRepository(db, user.id),
      workout: new PrismaWorkoutRepository(db, user.id),
      workoutDateOverride: new PrismaWorkoutDateOverrideRepository(db, user.id),
      workoutLiftOverride: new PrismaWorkoutLiftOverrideRepository(db, user.id),
      workoutSkipOverride: new PrismaWorkoutSkipOverrideRepository(db, user.id),
      liftingProgramSpec: new HybridLiftingProgramSpecRepository(
        db,
        user.id,
        this.inMemorySpecRepo,
      ),
    };
  }
}
