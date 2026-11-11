import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import type { LiftProgressionType } from '@lifting-logbook/types';
import { IsLiftProgression, IsProgressionIncrement, IsProgressionReps } from './progression.validation';

export class PatchLiftMetadataDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  muscleGroups?: string[];

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  substitutions?: string[];

  @IsBoolean()
  @IsOptional()
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
