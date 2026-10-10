import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { programLengthWeeks } from '@lifting-logbook/core';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IMacrocycleDashboardRepository } from '../ports/IMacrocycleDashboardRepository';
import { ILiftingProgramSpecRepository } from '../ports/ILiftingProgramSpecRepository';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { isValidWorkoutNum, workoutKeyForWorkoutNum } from './mappers';

class SkipWorkoutDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

@Controller('programs/:program')
export class WorkoutSkipController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Post('macrocycles/:macrocycleNum/workouts/:workoutNum/skip')
  @HttpCode(HttpStatus.NO_CONTENT)
  async skipWorkout(
    @Param('program') program: string,
    @Param('macrocycleNum') macrocycleNumParam: string,
    @Param('workoutNum') workoutNumParam: string,
    @Body() dto: SkipWorkoutDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    const macrocycleNum = Number.parseInt(macrocycleNumParam, 10);
    const workoutNum = Number.parseInt(workoutNumParam, 10);

    if (!Number.isInteger(macrocycleNum) || macrocycleNum < 1) {
      throw new BadRequestException('macrocycleNum must be a positive integer');
    }
    if (!isValidWorkoutNum(workoutNum)) {
      throw new BadRequestException('workoutNum must be a positive integer');
    }

    const { workoutSkipOverride, liftingProgramSpec, macrocycleDashboard } =
      await this.factory.forUser(user);
    await this.assertActiveInBoundsTarget(
      program,
      macrocycleNum,
      workoutNum,
      liftingProgramSpec,
      macrocycleDashboard,
    );
    await workoutSkipOverride.skipWorkout(program, macrocycleNum, workoutNum, dto.reason);
  }

  @Delete('macrocycles/:macrocycleNum/workouts/:workoutNum/skip')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unskipWorkout(
    @Param('program') program: string,
    @Param('macrocycleNum') macrocycleNumParam: string,
    @Param('workoutNum') workoutNumParam: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    const macrocycleNum = Number.parseInt(macrocycleNumParam, 10);
    const workoutNum = Number.parseInt(workoutNumParam, 10);

    if (!Number.isInteger(macrocycleNum) || macrocycleNum < 1) {
      throw new BadRequestException('macrocycleNum must be a positive integer');
    }
    if (!isValidWorkoutNum(workoutNum)) {
      throw new BadRequestException('workoutNum must be a positive integer');
    }

    const { workoutSkipOverride, liftingProgramSpec, macrocycleDashboard } =
      await this.factory.forUser(user);
    await this.assertActiveInBoundsTarget(
      program,
      macrocycleNum,
      workoutNum,
      liftingProgramSpec,
      macrocycleDashboard,
    );
    await workoutSkipOverride.unskipWorkout(program, macrocycleNum, workoutNum);
  }

  /**
   * Rejects a skip/unskip target the current-macrocycle read model could never
   * surface, so the endpoint can't silently record dead data (a 204 with no
   * visible effect — the failure mode #773 flagged). Shared by both skip (POST)
   * and unskip (DELETE); mirrors the RescheduleController bounds/macrocycle checks
   * (#773/#775). Order matters — spec (404) → workoutNum bound (400) → active
   * macrocycle (400) — so the cheapest, most-specific failure wins and the dashboard
   * is only loaded once the workoutNum is known to be in range.
   */
  private async assertActiveInBoundsTarget(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    liftingProgramSpec: ILiftingProgramSpecRepository,
    macrocycleDashboard: IMacrocycleDashboardRepository,
  ): Promise<void> {
    const spec = await liftingProgramSpec.getProgramSpec(program);
    if (spec.length === 0) {
      throw new NotFoundException(`Program '${program}' not found`);
    }

    // Reject a workoutNum past the program's spec-derived canonical length, via
    // the same workoutKeyForWorkoutNum helper the GET workout endpoint uses.
    // Without this a skip is recorded for a workoutNum that maps to no real
    // workout day and is silently never surfaced.
    if (workoutKeyForWorkoutNum(spec, workoutNum, program) === undefined) {
      throw new BadRequestException(
        `workoutNum ${workoutNum} exceeds the program's ${programLengthWeeks(program, spec)}-week schedule`,
      );
    }

    // getMacrocycleDashboard throws ProgramNotFoundError when the program has no
    // macrocycle. Its macrocycleNum is the *active* macrocycle, and the entire read model (GET
    // workout, macrocycle dashboard, getSkipsForMacrocycle) reads only that macrocycle — a skip
    // written for any other macrocycleNum is dead data the client can never see.
    const dashboard = await macrocycleDashboard.getMacrocycleDashboard(program);
    if (macrocycleNum !== dashboard.macrocycleNum) {
      throw new BadRequestException(
        `macrocycleNum ${macrocycleNum} is not the active macrocycle (${dashboard.macrocycleNum})`,
      );
    }
  }
}
