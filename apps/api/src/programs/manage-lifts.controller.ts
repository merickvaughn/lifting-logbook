import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { LIFT_NAMES, LiftOverrideResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { toLiftOverrideResponse, isValidWorkoutNum } from './mappers';
import { LiftOverrideDto } from './lift-override.dto';

@Controller('programs/:program')
export class ManageLiftsController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Get('lifts')
  async getLifts(@CurrentUser() user: AuthUser): Promise<string[]> {
    // Merge the user's custom lift names with the built-in catalog so they are
    // selectable everywhere lifts are picked. Downstream consumers (training
    // maxes, lift records, workout generation) already accept arbitrary lift
    // strings, so no further wiring is needed. Deduped so a custom lift named
    // after a built-in does not appear twice.
    const { customLift } = await this.factory.forUser(user);
    const customNames = (await customLift.list()).map((c) => c.name);
    return Array.from(new Set([...LIFT_NAMES, ...customNames]));
  }

  @Post('macrocycles/:macrocycleNum/workouts/:workoutNum/lift-overrides')
  @HttpCode(HttpStatus.CREATED)
  async upsertOverride(
    @Param('program') program: string,
    @Param('macrocycleNum') macrocycleNumParam: string,
    @Param('workoutNum') workoutNumParam: string,
    @Body() dto: LiftOverrideDto,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftOverrideResponse> {
    const macrocycleNum = Number.parseInt(macrocycleNumParam, 10);
    const workoutNum = Number.parseInt(workoutNumParam, 10);

    if (!Number.isInteger(macrocycleNum) || macrocycleNum < 1) {
      throw new BadRequestException('macrocycleNum must be a positive integer');
    }
    if (!isValidWorkoutNum(workoutNum)) {
      throw new BadRequestException('workoutNum must be a positive integer');
    }
    if (dto.action === 'replace' && !dto.replacedBy) {
      throw new BadRequestException("replacedBy is required when action is 'replace'");
    }

    const { macrocycleDashboard, workoutLiftOverride, liftingProgramSpec } = await this.factory.forUser(user);

    const spec = await liftingProgramSpec.getProgramSpec(program);
    if (spec.length === 0) {
      throw new NotFoundException(`Program '${program}' not found`);
    }

    await macrocycleDashboard.getMacrocycleDashboard(program);

    const override = {
      lift: dto.lift,
      action: dto.action,
      ...(dto.replacedBy !== undefined && { replacedBy: dto.replacedBy }),
    };
    await workoutLiftOverride.upsertOverride(program, macrocycleNum, workoutNum, override);
    return toLiftOverrideResponse(override);
  }

  @Delete('macrocycles/:macrocycleNum/workouts/:workoutNum/lift-overrides/:lift')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOverride(
    @Param('program') program: string,
    @Param('macrocycleNum') macrocycleNumParam: string,
    @Param('workoutNum') workoutNumParam: string,
    @Param('lift') lift: string,
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

    const { workoutLiftOverride } = await this.factory.forUser(user);
    await workoutLiftOverride.deleteOverride(program, macrocycleNum, workoutNum, decodeURIComponent(lift));
  }
}
