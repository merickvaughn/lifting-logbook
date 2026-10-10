import { Module } from '@nestjs/common';
import { macrocyclePlanningAgentProvider } from '../adapters/llm/macrocycle-planning-provider.factory';
import { BodyWeightController } from './body-weight.controller';
import { MacrocycleDashboardController } from './macrocycle-dashboard.controller';
import { MacrocycleGenerationController } from './macrocycle-generation.controller';
import { MacrocycleGenerationService } from './macrocycle-generation.service';
import { MacrocyclePlanController } from './macrocycle-plan.controller';
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
    MacrocycleDashboardController,
    MacrocycleGenerationController,
    MacrocyclePlanController,
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
    macrocyclePlanningAgentProvider,
    MacrocycleGenerationService,
  ],
})
export class ProgramsModule {}
