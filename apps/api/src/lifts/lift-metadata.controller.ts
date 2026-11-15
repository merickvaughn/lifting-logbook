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
import { ILiftMetadataRepository, LiftMetadata, LiftMetadataPatch } from '../ports/ILiftMetadataRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { PatchLiftMetadataDto } from './patch-lift-metadata.dto';

function toResponse(meta: LiftMetadata): LiftMetadataResponse {
  return {
    lift: meta.lift,
    muscleGroups: meta.muscleGroups,
    secondaryMuscleGroups: meta.secondaryMuscleGroups,
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
  'secondaryMuscleGroups',
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

  /**
   * Every lift the lifter has stored metadata for (#1211). The workout logger reads it once and
   * finds a lift's row with `lookupByLift`, as `updateMaxes` does, so both cross spellings alike.
   */
  @Get('metadata')
  async listMetadata(@CurrentUser() user: AuthUser): Promise<LiftMetadataResponse[]> {
    const { liftMetadata } = await this.factory.forUser(user);
    return (await liftMetadata.listMetadata()).map(toResponse);
  }

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
          secondaryMuscleGroups: [],
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

    const { stored, legacy } = await readLegacyRow(liftMetadata, lift);
    // A row saved before #1017 under the lift's URL-encoded name is retired by this save. Until
    // the real name has a row of its own, the legacy row is the lift's metadata, so its values
    // are the starting point and none of them is lost.
    const base = stored === null && legacy ? legacy : undefined;

    // The DTO checks a range sent whole; a patch that sets one end and leaves the other out is
    // checked against the other end as stored, so the row never holds a bottom above its top
    // (#1210). The read and the write are separate, so two overlapping one-end patches could
    // still cross the range; #1211's reader treats a crossed range as unset.
    const lowOnly = typeof patch.repsLow === 'number' && patch.repsHigh === undefined;
    const highOnly = typeof patch.repsHigh === 'number' && patch.repsLow === undefined;
    if (lowOnly || highOnly) {
      const current = stored === undefined ? await liftMetadata.getMetadata(lift) : stored ?? base;
      const repsLow = lowOnly ? patch.repsLow : current?.repsLow;
      const repsHigh = highOnly ? patch.repsHigh : current?.repsHigh;
      if (typeof repsLow === 'number' && typeof repsHigh === 'number' && repsLow > repsHigh) {
        throw new BadRequestException('repsLow must be at most repsHigh');
      }
    }

    if (base) {
      for (const field of PATCH_FIELDS) {
        if (patch[field] === undefined) Object.assign(patch, { [field]: base[field] });
      }
    }
    const saved = await liftMetadata.upsertMetadata(lift, patch);
    // RlsInterceptor runs the request in one transaction, so the write and this delete land or
    // fail together: a failed delete rolls the save back and the PATCH reports it.
    if (legacy) await liftMetadata.deleteMetadata(legacy.lift);
    return toResponse(saved);
  }
}

/**
 * The row stored under `lift` and the legacy row stored under exactly the name the pre-#1017
 * editor saved, `encodeURIComponent(lift)`. Nothing else is matched, so a row whose name only
 * looks encoded is never deleted. Read only when encoding changes `lift`, since only then can a
 * legacy row exist; `stored` is undefined when nothing was read.
 */
async function readLegacyRow(
  liftMetadata: ILiftMetadataRepository,
  lift: string,
): Promise<{ stored: LiftMetadata | null | undefined; legacy: LiftMetadata | null }> {
  const encoded = encodeURIComponent(lift);
  if (encoded === lift) return { stored: undefined, legacy: null };
  // Sequential: the request's queries share one interactive transaction.
  const stored = await liftMetadata.getMetadata(lift);
  const legacy = await liftMetadata.getMetadata(encoded);
  return { stored, legacy };
}
