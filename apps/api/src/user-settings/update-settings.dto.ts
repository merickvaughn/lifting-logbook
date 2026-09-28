import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
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
  SCHEDULE_LIMITS,
  WEIGHT_INCREMENT_OPTIONS,
  WEIGHT_UNIT_OPTIONS,
  isValidSchedule,
} from '@lifting-logbook/types';
import type { UserWorkoutSchedule, WeightUnit } from '@lifting-logbook/types';

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
  @IsIn(['fixed', 'rotating'])
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

  // Cross-field check. Attached to `type` so the error message hangs off a defined property
  // regardless of which arm the caller used.
  @Validate(IsScheduleShapeConstraint)
  _shape?: never;
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
}
