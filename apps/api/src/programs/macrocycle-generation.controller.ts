import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import {
  MACROCYCLE_ID_HEADER,
  MacrocycleDashboardResponse,
  RecalculateMaxesResponse,
} from '@lifting-logbook/types';
import { weekTypeForDate } from '@lifting-logbook/core';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { toMacrocycleDashboardResponse, toTrainingMaxResponse } from './mappers';
import { ParseProgramPipe } from './program.pipe';
import { InitializeMacrocycleDto } from './initialize-macrocycle.dto';
import { StartNewMacrocycleDto } from './start-new-macrocycle.dto';
import { MacrocycleGenerationService } from './macrocycle-generation.service';

@Controller('programs/:program')
export class MacrocycleGenerationController {
  constructor(
    private readonly macrocycleGenerationService: MacrocycleGenerationService,
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  // NOTE: 'macrocycles/initialize' must be declared before 'macrocycles' so NestJS matches
  // the literal path segment "initialize" before the advance-macrocycle handler.
  @Post('macrocycles/initialize')
  async initializeFirstMacrocycle(
    @Param('program', ParseProgramPipe) program: string,
    @Body() dto: InitializeMacrocycleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<MacrocycleDashboardResponse> {
    const repos = await this.factory.forUser(user);
    const { dashboard, programSpec, scheduledWorkouts } =
      await this.macrocycleGenerationService.initializeFirstMacrocycle(repos, program, dto);
    // A macrocycle just started has no rescheduled workouts yet.
    const currentWeekType = weekTypeForDate(program, dashboard.macrocycleDate, programSpec, {
      scheduled: scheduledWorkouts,
      overrides: new Map(),
    });
    return toMacrocycleDashboardResponse(dashboard, currentWeekType);
  }

  @Post('macrocycles')
  async startNewMacrocycle(
    @Param('program', ParseProgramPipe) program: string,
    @Body() dto: StartNewMacrocycleDto,
    @CurrentUser() user: AuthUser,
    @Headers(MACROCYCLE_ID_HEADER) macrocycleId?: string,
  ): Promise<MacrocycleDashboardResponse> {
    const repos = await this.factory.forUser(user);
    const { dashboard: newMacrocycle, programSpec, scheduledWorkouts } =
      await this.macrocycleGenerationService.startNewMacrocycle(repos, program, dto, macrocycleId);
    const currentWeekType = weekTypeForDate(program, newMacrocycle.macrocycleDate, programSpec, {
      scheduled: scheduledWorkouts,
      overrides: new Map(),
    });
    return toMacrocycleDashboardResponse(newMacrocycle, currentWeekType);
  }

  @Post('training-maxes/recalculate')
  @HttpCode(HttpStatus.OK)
  async recalculateMaxes(
    @Param('program', ParseProgramPipe) program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<RecalculateMaxesResponse> {
    const repos = await this.factory.forUser(user);
    const { maxes, flagged, skipped } = await this.macrocycleGenerationService.recalculateMaxes(repos, program);
    return { maxes: maxes.map(toTrainingMaxResponse), flagged, skipped };
  }
}
