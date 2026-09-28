import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
} from '@nestjs/common';
import { programLengthWeeks } from '@lifting-logbook/core';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { isValidWorkoutNum, workoutKeyForWorkoutNum } from './mappers';
import { RescheduleDto } from './reschedule.dto';

@Controller('programs/:program')
export class RescheduleController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Patch('cycles/:cycleNum/workouts/:workoutNum/reschedule')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reschedule(
    @Param('program') program: string,
    @Param('cycleNum') cycleNumParam: string,
    @Param('workoutNum') workoutNumParam: string,
    @Body() dto: RescheduleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    const cycleNum = Number.parseInt(cycleNumParam, 10);
    const workoutNum = Number.parseInt(workoutNumParam, 10);

    if (!Number.isInteger(cycleNum) || cycleNum < 1) {
      throw new BadRequestException('cycleNum must be a positive integer');
    }
    if (!isValidWorkoutNum(workoutNum)) {
      throw new BadRequestException('workoutNum must be a positive integer');
    }

    const { cycleDashboard, workoutDateOverride, liftingProgramSpec } = await this.factory.forUser(user);

    const spec = await liftingProgramSpec.getProgramSpec(program);
    if (spec.length === 0) {
      throw new NotFoundException(`Program '${program}' not found`);
    }

    // Reject a workoutNum past the program's spec-derived canonical length, via the
    // same workoutKeyForWorkoutNum helper the GET workout endpoint uses. (GET also
    // serves a scheduled row past the program's last day as a workout with no
    // planned lifts, so its bound is marginally looser. Such a row is left by a
    // cycle scheduled before #1023, or by a program that has since lost days.)
    // Without this an override is upserted for a workoutNum that maps to no real workout
    // day and is silently never surfaced (204 success, no visible effect).
    if (workoutKeyForWorkoutNum(spec, workoutNum, program) === undefined) {
      throw new BadRequestException(
        `workoutNum ${workoutNum} exceeds the program's ${programLengthWeeks(program, spec)}-week schedule`,
      );
    }

    // getCycleDashboard throws ProgramNotFoundError when the program has no cycle.
    // Its cycleNum is the *active* cycle, and the entire read model (GET workout,
    // cycle dashboard, getOverride) reads only that cycle — an override written for
    // any other cycleNum is dead data the client can never see. Reject a non-active
    // cycleNum rather than accept a 204-with-no-effect reschedule.
    const dashboard = await cycleDashboard.getCycleDashboard(program);
    if (cycleNum !== dashboard.cycleNum) {
      throw new BadRequestException(
        `cycleNum ${cycleNum} is not the active cycle (${dashboard.cycleNum})`,
      );
    }

    // Append explicit UTC midnight so the YYYY-MM-DD string is stored as the correct calendar day
    // regardless of the server's local timezone.
    await workoutDateOverride.upsertOverride(
      program,
      cycleNum,
      workoutNum,
      new Date(dto.newDate + 'T00:00:00Z'),
    );
  }
}
