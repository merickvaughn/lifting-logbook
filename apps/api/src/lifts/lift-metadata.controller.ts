import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
} from '@nestjs/common';
import { LiftMetadataResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { LiftMetadata, LiftMetadataPatch } from '../ports/ILiftMetadataRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { PatchLiftMetadataDto } from './patch-lift-metadata.dto';

function toResponse(meta: LiftMetadata): LiftMetadataResponse {
  return {
    lift: meta.lift,
    muscleGroups: meta.muscleGroups,
    substitutions: meta.substitutions,
    foundational: meta.foundational,
    progression: meta.progression,
    progressionIncrement: meta.progressionIncrement,
    repsLow: meta.repsLow,
    repsHigh: meta.repsHigh,
  };
}

const PATCH_FIELDS = [
  'muscleGroups',
  'substitutions',
  'foundational',
  'progression',
  'progressionIncrement',
  'repsLow',
  'repsHigh',
] as const;

@Controller('lifts')
export class LiftMetadataController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Get(':lift/metadata')
  async getMetadata(
    @Param('lift') lift: string,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftMetadataResponse> {
    const { liftMetadata } = await this.factory.forUser(user);
    const meta = await liftMetadata.getMetadata(lift);
    return meta
      ? toResponse(meta)
      : {
          lift,
          muscleGroups: [],
          substitutions: [],
          foundational: false,
          progression: null,
          progressionIncrement: null,
          repsLow: null,
          repsHigh: null,
        };
  }

  @Patch(':lift/metadata')
  @HttpCode(HttpStatus.OK)
  async patchMetadata(
    @Param('lift') lift: string,
    @Body() dto: PatchLiftMetadataDto,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftMetadataResponse> {
    const { liftMetadata } = await this.factory.forUser(user);
    const patch: LiftMetadataPatch = {};
    for (const field of PATCH_FIELDS) {
      if (dto[field] !== undefined) Object.assign(patch, { [field]: dto[field] });
    }

    // The DTO checks a range sent whole; a patch that sends one end is checked against the
    // other end as stored, so the row never holds a bottom above its top (#1210).
    if (patch.repsLow !== undefined || patch.repsHigh !== undefined) {
      const stored = await liftMetadata.getMetadata(lift);
      const repsLow = patch.repsLow !== undefined ? patch.repsLow : stored?.repsLow ?? null;
      const repsHigh = patch.repsHigh !== undefined ? patch.repsHigh : stored?.repsHigh ?? null;
      if (repsLow !== null && repsHigh !== null && repsLow > repsHigh) {
        throw new BadRequestException('repsLow must be at most repsHigh');
      }
    }

    return toResponse(await liftMetadata.upsertMetadata(lift, patch));
  }
}
