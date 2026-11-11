import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { LIFT_PROGRESSION_TYPES, PROGRESSION_REPS_LIMITS } from '@lifting-logbook/types';
import type { LiftProgressionType } from '@lifting-logbook/types';
import { IsAtMostSibling } from './progression.validation';

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
  // `@IsOptional` skips the checks for null as well as undefined. `rpe` is not selectable on
  // a lift until per-set RPE logging exists, so it is rejected with any unknown type.
  @IsOptional()
  @IsIn(LIFT_PROGRESSION_TYPES)
  progression?: LiftProgressionType | null;

  // Must be > 0, like a spec row's increment: a zero increment makes rounding divide by zero.
  @IsOptional()
  @IsNumber()
  @IsPositive()
  progressionIncrement?: number | null;

  // Checked against `repsHigh` here when both are sent; the controller checks a partial
  // patch against the stored row.
  @IsOptional()
  @IsInt()
  @Min(PROGRESSION_REPS_LIMITS.MIN)
  @Max(PROGRESSION_REPS_LIMITS.MAX)
  @Validate(IsAtMostSibling, ['repsHigh'])
  repsLow?: number | null;

  @IsOptional()
  @IsInt()
  @Min(PROGRESSION_REPS_LIMITS.MIN)
  @Max(PROGRESSION_REPS_LIMITS.MAX)
  repsHigh?: number | null;
}
