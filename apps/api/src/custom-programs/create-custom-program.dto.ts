import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { LiftProgressionType } from '@lifting-logbook/types';
import { IsLiftProgression, IsProgressionReps } from '../lifts/progression.validation';

// Cross-field guard: the work percentage for set i is (1 - i * wtDecrementPct), so the
// final set is (1 - (sets-1) * wtDecrementPct). When that goes below 0 the prescribed
// weight is negative — PROG_SPEC_WORK_PCTS throws a RangeError at plan-generation time.
// Enforcing the bound here turns that latent 500 into a 400 at creation. Mirrors the
// core guard exactly (minPct >= 0 is allowed; a final set of 0 is valid).
@ValidatorConstraint({ name: 'wtDecrementWithinSetBound', async: false })
export class WtDecrementWithinSetBound implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const { sets } = args.object as { sets?: unknown };
    // Defer to @IsInt/@Min/@IsNumber for type/range errors on the sibling fields;
    // a single-set scheme has no later set to drive negative.
    if (typeof sets !== 'number' || typeof value !== 'number' || sets <= 1) return true;
    return 1 - (sets - 1) * value >= 0;
  }
  defaultMessage(args: ValidationArguments): string {
    const { sets } = args.object as { sets?: number };
    const bound = typeof sets === 'number' && sets > 1 ? 1 / (sets - 1) : 1;
    return `wtDecrementPct must be at most ${bound} for ${sets ?? '?'} sets (a larger value drives the final set's weight negative)`;
  }
}

export class CustomProgramSpecRowDto {
  @IsInt() @IsIn([1, 2, 3]) week!: number;
  @IsInt() @Min(0) offset!: number;
  @IsString() lift!: string;
  // Must be > 0 — a zero increment makes MROUND divide by zero (NaN weights).
  @IsNumber() @IsPositive() increment!: number;
  @IsInt() @Min(1) order!: number;
  @IsInt() @Min(1) @Max(20) sets!: number;
  @IsInt() @Min(1) @Max(20) reps!: number;
  @IsBoolean() amrap!: boolean;
  @IsString() warmUpPct!: string;
  // Per-set weight drop, as a fraction of TM. @Min/@Max block the gross cases;
  // WtDecrementWithinSetBound enforces the exact cross-field bound (≤ 1/(sets-1)).
  @IsNumber() @Min(0) @Max(1) @Validate(WtDecrementWithinSetBound) wtDecrementPct!: number;
  @IsString() activation!: string;
  @IsOptional() @IsString() weekType?: string;
  // The row's progression override (#1210). A row with none follows the lift's own value. On
  // an update, leaving either field out keeps the stored value and null clears it, except that
  // a kept `repsLow` above the row's `reps` is cleared. `repsLow` is the bottom of the range
  // whose top is `reps`, so `reps` bounds it.
  @IsOptional() @IsLiftProgression() progression?: LiftProgressionType | null;
  @IsOptional() @IsProgressionReps('reps') repsLow?: number | null;
}

export class CreateCustomProgramDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() baseTemplate?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CustomProgramSpecRowDto)
  specs!: CustomProgramSpecRowDto[];
}
