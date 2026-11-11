import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import {
  LIFT_PROGRESSION_TYPES,
  PROGRESSION_REPS_LIMITS,
  SCHEDULE_LIMITS,
  WEIGHT_INCREMENT_OPTIONS,
  WEIGHT_UNIT_OPTIONS,
  isValidSchedule,
} from '@lifting-logbook/types';
import type { LiftProgressionType, UserWorkoutSchedule, WeightUnit } from '@lifting-logbook/types';
import { IsAtMostSibling } from '../lifts/progression.validation';
import type { DefaultProgressionPatch } from '../ports/IUserSettingsRepository';

// Delegates to the shared `isValidSchedule` predicate so the write-side and read-side
// bounds (range, uniqueness, max weeks, max days/week) cannot drift.
@ValidatorConstraint({ name: 'IsWeekPatternArray', async: false })
class IsWeekPatternArrayConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidSchedule({ type: 'rotating', weeks: value });
  }
  defaultMessage(): string {
    return `weeks must be 1-${SCHEDULE_LIMITS.MAX_ROTATING_WEEKS} arrays of unique day indices (0-6, max ${SCHEDULE_LIMITS.MAX_DAYS_PER_WEEK} per week)`;
  }
}

// Class-level discriminator check: fixed ⇔ days only; rotating ⇔ weeks only.
// @ValidateIf gates the per-field validators but does not reject the *presence* of the
// inactive field, so a payload with both arms would otherwise pass and persist garbage.
@ValidatorConstraint({ name: 'IsScheduleShape', async: false })
class IsScheduleShapeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const o = args.object as WorkoutScheduleDto;
    if (o.type === 'fixed') return o.days !== undefined && o.weeks === undefined;
    if (o.type === 'rotating') return o.weeks !== undefined && o.days === undefined;
    return false;
  }
  defaultMessage(): string {
    return "fixed schedules require only 'days'; rotating schedules require only 'weeks'";
  }
}

export class WorkoutScheduleDto implements UserWorkoutSchedule {
  // The cross-field shape check hangs off `type`, a real field, so the error message has a
  // defined property regardless of which arm the caller used. It must not hang off a
  // placeholder property: decorating one makes it a whitelisted key whose own value nothing
  // validates, which let arbitrary payloads persist under it (#1034).
  @IsIn(['fixed', 'rotating'])
  @Validate(IsScheduleShapeConstraint)
  type!: 'fixed' | 'rotating';

  @ValidateIf((o: WorkoutScheduleDto) => o.type === 'fixed')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SCHEDULE_LIMITS.MAX_DAYS_PER_WEEK)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];

  @ValidateIf((o: WorkoutScheduleDto) => o.type === 'rotating')
  @Validate(IsWeekPatternArrayConstraint)
  weeks?: number[][];
}

// The lifter's default progression (#1210). Validated like a lift's own value in
// PatchLiftMetadataDto: `rpe` and unknown types are rejected, the increment is positive, and
// the range's bottom may not exceed its top. The default is replaced whole, so the range is
// always checked within one request.
export class DefaultProgressionDto implements DefaultProgressionPatch {
  @IsIn(LIFT_PROGRESSION_TYPES)
  type!: LiftProgressionType;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  increment?: number | null;

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

export class UpdateSettingsDto {
  // Unlike the other three fields, activeProgram has no clear-via-null semantics — it's
  // switched by POST /programs/:program/switch, not cleared here. @IsOptional() would let
  // `null` through unvalidated (class-validator skips every check when the value is exactly
  // `null`, not just `undefined`) and both adapters would then null out the column; reject it
  // explicitly instead so the port's `activeProgram?: string` (no `| null`) type stays accurate.
  @ValidateIf((o: UpdateSettingsDto) => o.activeProgram !== undefined)
  @IsString()
  @MaxLength(64)
  activeProgram?: string;

  // null clears the schedule; undefined leaves it unchanged.
  @IsOptional()
  // Reject primitives like { workoutSchedule: "x" } that would otherwise bypass
  // @ValidateNested (which silently no-ops on non-objects) and write garbage to JSONB.
  @ValidateIf((o: UpdateSettingsDto) => o.workoutSchedule !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => WorkoutScheduleDto)
  workoutSchedule?: WorkoutScheduleDto | null;

  // null clears the setting (falls back to the 1.25 app default); undefined leaves
  // it unchanged. Constrained to plate sizes users actually have on hand — see
  // docs/standards/training-max-precision.md.
  @IsOptional()
  @ValidateIf((o: UpdateSettingsDto) => o.defaultWeightIncrement !== null)
  @IsIn(WEIGHT_INCREMENT_OPTIONS)
  defaultWeightIncrement?: number | null;

  // null clears the preference (falls back to 'lbs'); undefined leaves it unchanged.
  // Display preference only — never rounds or rewrites stored weights.
  @IsOptional()
  @ValidateIf((o: UpdateSettingsDto) => o.unit !== null)
  @IsIn(WEIGHT_UNIT_OPTIONS)
  unit?: WeightUnit | null;

  // null clears the default so each lift's catalog default applies; undefined leaves it
  // unchanged. The object check rejects a primitive the nested validation would skip.
  @IsOptional()
  @ValidateIf((o: UpdateSettingsDto) => o.defaultProgression !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => DefaultProgressionDto)
  defaultProgression?: DefaultProgressionDto | null;
}
