import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  FOCUS_ALIGNS,
  FOCUS_AREAS,
  FOCUS_INCLUDES,
  FOCUS_LIMITS,
  FOCUS_ON_ENDS,
  FOCUS_OVERLAPS,
  FOCUS_PERIODS,
  FOCUS_PROGRESSIONS,
  FOCUS_SELECTIONS,
} from '@lifting-logbook/types';
import type {
  CreateFocusBlockRequest,
  FocusAlign,
  FocusArea,
  FocusInclude,
  FocusOnEnd,
  FocusOverlap,
  FocusPeriod,
  FocusPoolEntry,
  FocusProgression,
  FocusSelection,
  FocusTimer,
  ReorderFocusBlocksRequest,
  UpdateFocusBlockRequest,
  UpdateFocusSettingsRequest,
} from '@lifting-logbook/types';


/** `YYYY-MM-DD`. The controller checks the day exists in its month. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Picks, trims, swapTo and ruleLift name a pool lift, so each lift may appear once.
// Case-sensitive, as those names are compared. Malformed entries are left to the other checks.
@ValidatorConstraint({ name: 'HasUniquePoolLifts', async: false })
class HasUniquePoolLiftsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return true;
    const lifts = value
      .map((entry: unknown) => (entry as { lift?: unknown } | null)?.lift)
      .filter((lift): lift is string => typeof lift === 'string');
    return new Set(lifts).size === lifts.length;
  }
  defaultMessage(): string {
    return 'pool must not list the same lift more than once';
  }
}

export class FocusTimerDto implements FocusTimer {
  @IsInt() @Min(0) @Max(FOCUS_LIMITS.MAX_TIMER_SEC) prep!: number;
  @IsInt() @Min(0) @Max(FOCUS_LIMITS.MAX_TIMER_SEC) set!: number;
  @IsInt() @Min(0) @Max(FOCUS_LIMITS.MAX_TIMER_SEC) rest!: number;
}

export class FocusPoolEntryDto implements FocusPoolEntry {
  @IsString() @MinLength(1) @MaxLength(FOCUS_LIMITS.MAX_LIFT_NAME) lift!: string;

  @IsIn(FOCUS_INCLUDES) include!: FocusInclude;

  // Empty means "none", as in the prototype.
  @IsString() @MaxLength(FOCUS_LIMITS.MAX_LIFT_NAME) ruleLift!: string;
  @IsString() @MaxLength(FOCUS_LIMITS.MAX_LIFT_NAME) swapTo!: string;

  @IsInt() @Min(1) @Max(FOCUS_LIMITS.MAX_SETS) sets!: number;
  @IsInt() @Min(1) @Max(FOCUS_LIMITS.MAX_REPS) repsLow!: number;
  @IsInt() @Min(1) @Max(FOCUS_LIMITS.MAX_REPS) repsHigh!: number;

  // Directly known weights: any value the user enters, never rounded.
  @IsNumber() @Min(0) @Max(FOCUS_LIMITS.MAX_WEIGHT) weight!: number;
  @IsNumber() @Min(0) @Max(FOCUS_LIMITS.MAX_WEIGHT) trainingMax!: number;
  @IsNumber() @Min(0) @Max(100) percent!: number;
  @IsNumber() @Min(1) @Max(10) rpe!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FOCUS_LIMITS.MAX_SETS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(FOCUS_LIMITS.MAX_REPS, { each: true })
  lastReps?: number[];
}

/** The fields a focus block's create and update share. */
class FocusBlockFieldsDto {
  @IsIn(FOCUS_AREAS) area!: FocusArea;
  @IsIn(FOCUS_PERIODS) period!: FocusPeriod;
  @IsIn(FOCUS_ALIGNS) align!: FocusAlign;
  @IsString() @Matches(ISO_DATE_PATTERN, { message: 'start must be an ISO date (YYYY-MM-DD)' }) start!: string;
  @IsIn(FOCUS_SELECTIONS) selection!: FocusSelection;
  @IsIn(FOCUS_OVERLAPS) overlap!: FocusOverlap;
  @IsIn(FOCUS_PROGRESSIONS) progression!: FocusProgression;

  // Rejects primitives, which @ValidateNested alone silently accepts.
  @IsObject()
  @ValidateNested()
  @Type(() => FocusTimerDto)
  timer!: FocusTimerDto;

  @IsIn(FOCUS_ON_ENDS) onEnd!: FocusOnEnd;

  // Explicit null: no next area.
  @ValidateIf((o: FocusBlockFieldsDto) => o.nextArea !== null)
  @IsIn(FOCUS_AREAS)
  nextArea!: FocusArea | null;

  @IsArray()
  @ArrayMaxSize(FOCUS_LIMITS.MAX_POOL)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Validate(HasUniquePoolLiftsConstraint)
  @Type(() => FocusPoolEntryDto)
  pool!: FocusPoolEntryDto[];
}

export class CreateFocusBlockDto extends FocusBlockFieldsDto implements CreateFocusBlockRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  series?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(FOCUS_LIMITS.MAX_PRIORITY)
  priority?: number;
}

/**
 * Every field optional. @ValidateIf rather than @IsOptional, so an explicit `null` is
 * rejected for the fields where null means nothing (only `nextArea` takes null).
 */
export class UpdateFocusBlockDto implements UpdateFocusBlockRequest {
  @ValidateIf((o: UpdateFocusBlockDto) => o.area !== undefined) @IsIn(FOCUS_AREAS) area?: FocusArea;
  @ValidateIf((o: UpdateFocusBlockDto) => o.period !== undefined) @IsIn(FOCUS_PERIODS) period?: FocusPeriod;
  @ValidateIf((o: UpdateFocusBlockDto) => o.align !== undefined) @IsIn(FOCUS_ALIGNS) align?: FocusAlign;

  @ValidateIf((o: UpdateFocusBlockDto) => o.start !== undefined)
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'start must be an ISO date (YYYY-MM-DD)' })
  start?: string;

  @ValidateIf((o: UpdateFocusBlockDto) => o.selection !== undefined)
  @IsIn(FOCUS_SELECTIONS)
  selection?: FocusSelection;

  @ValidateIf((o: UpdateFocusBlockDto) => o.overlap !== undefined) @IsIn(FOCUS_OVERLAPS) overlap?: FocusOverlap;

  @ValidateIf((o: UpdateFocusBlockDto) => o.progression !== undefined)
  @IsIn(FOCUS_PROGRESSIONS)
  progression?: FocusProgression;

  @ValidateIf((o: UpdateFocusBlockDto) => o.timer !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => FocusTimerDto)
  timer?: FocusTimerDto;

  @ValidateIf((o: UpdateFocusBlockDto) => o.onEnd !== undefined) @IsIn(FOCUS_ON_ENDS) onEnd?: FocusOnEnd;

  @ValidateIf((o: UpdateFocusBlockDto) => o.nextArea !== undefined && o.nextArea !== null)
  @IsIn(FOCUS_AREAS)
  nextArea?: FocusArea | null;

  @ValidateIf((o: UpdateFocusBlockDto) => o.pool !== undefined)
  @IsArray()
  @ArrayMaxSize(FOCUS_LIMITS.MAX_POOL)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Validate(HasUniquePoolLiftsConstraint)
  @Type(() => FocusPoolEntryDto)
  pool?: FocusPoolEntryDto[];
}

export class ReorderFocusBlocksDto implements ReorderFocusBlocksRequest {
  @IsArray()
  @ArrayMaxSize(FOCUS_LIMITS.MAX_PRIORITY)
  @IsString({ each: true })
  ids!: string[];
}

export class FocusSettingsDto implements UpdateFocusSettingsRequest {
  @IsInt() @Min(0) @Max(FOCUS_LIMITS.MAX_GUIDE_SETS) sets!: number;
  @IsInt() @Min(0) @Max(FOCUS_LIMITS.MAX_GUIDE_MINUTES) minutes!: number;
}
