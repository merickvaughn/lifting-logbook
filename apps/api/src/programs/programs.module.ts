import { Module } from '@nestjs/common';
import { cyclePlanningAgentProvider } from '../adapters/llm/cycle-planning-provider.factory';
import { BodyWeightController } from './body-weight.controller';
import { CycleDashboardController } from './cycle-dashboard.controller';
import { CycleGenerationController } from './cycle-generation.controller';
import { CycleGenerationService } from './cycle-generation.service';
import { CyclePlanController } from './cycle-plan.controller';
import { ImportController } from './import.controller';
import { LiftRecordsController } from './lift-records.controller';
import { ManageLiftsController } from './manage-lifts.controller';
import { ProgramSpecController } from './program-spec.controller';
import { StrengthGoalsController } from './strength-goals.controller';
import { TrainingMaxesController } from './training-maxes.controller';
import { TrainingMaxHistoryController } from './training-max-history.controller';
import { RescheduleController } from './reschedule.controller';
import { SwitchProgramController } from './switch-program.controller';
import { WorkoutSkipController } from './workout-skip.controller';
import { WorkoutsController } from './workouts.controller';

@Module({
  controllers: [
    BodyWeightController,
    CycleDashboardController,
    CycleGenerationController,
    CyclePlanController,
    RescheduleController,
    SwitchProgramController,
    WorkoutSkipController,
    WorkoutsController,
    StrengthGoalsController,
    TrainingMaxesController,
    TrainingMaxHistoryController,
    LiftRecordsController,
    ManageLiftsController,
    ProgramSpecController,
    ImportController,
  ],
  providers: [
    cyclePlanningAgentProvider,
    CycleGenerationService,
  ],
})
export class ProgramsModule {}
