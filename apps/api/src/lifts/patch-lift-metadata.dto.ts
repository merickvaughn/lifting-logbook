import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { LiftProgressionType } from '@lifting-logbook/types';
import { IsLiftProgression, IsProgressionIncrement, IsProgressionReps } from './progression.validation';

// Checked unless the key is absent. `@IsOptional()` also skips `null`, which these non-nullable
// columns can't hold: Prisma rejects it with a validation error no filter maps, so the client got
// a 500 instead of a 400 (#1017 review; update-custom-lift.dto.ts has the same fix for #893).
const unlessAbsent = ValidateIf((_: object, value: unknown) => value !== undefined);

export class PatchLiftMetadataDto {
  @unlessAbsent
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  muscleGroups?: string[];

  @unlessAbsent
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  secondaryMuscleGroups?: string[];

  @unlessAbsent
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  substitutions?: string[];

  @unlessAbsent
  @IsBoolean()
  foundational?: boolean;

  // The progression fields (#1210). `null` clears one, so the lifter's default applies;
  // `@IsOptional` skips the checks for null as well as undefined.
  @IsOptional()
  @IsLiftProgression()
  progression?: LiftProgressionType | null;

  @IsOptional()
  @IsProgressionIncrement()
  progressionIncrement?: number | null;

  // Checked against `repsHigh` here when both are sent; the controller checks a partial
  // patch against the stored row.
  @IsOptional()
  @IsProgressionReps('repsHigh')
  repsLow?: number | null;

  @IsOptional()
  @IsProgressionReps()
  repsHigh?: number | null;
}
