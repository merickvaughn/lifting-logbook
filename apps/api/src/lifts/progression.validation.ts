import { applyDecorators } from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsPositive,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { LIFT_PROGRESSION_TYPES, PROGRESSION_REPS_LIMITS } from '@lifting-logbook/types';

/**
 * Cross-field guard for a progression rep range (#1210): the decorated value may not exceed
 * the sibling named in the constraint, e.g. `@Validate(IsAtMostSibling, ['repsHigh'])` on
 * `repsLow`. Passes when either side is absent or not a number, so `@IsInt`/`@Min` report
 * those, and so a partial patch is checked against stored values by its caller instead.
 */
@ValidatorConstraint({ name: 'isAtMostSibling', async: false })
export class IsAtMostSibling implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [sibling] = args.constraints as [string];
    const other = (args.object as Record<string, unknown>)[sibling];
    if (typeof value !== 'number' || typeof other !== 'number') return true;
    return value <= other;
  }
  defaultMessage(args: ValidationArguments): string {
    const [sibling] = args.constraints as [string];
    return `${args.property} must be at most ${sibling}`;
  }
}

// The rules every progression field shares, wherever it is set (a lift, the lifter's default,
// a program row), so the values #1211 feeds into one resolver are validated one way. Each
// call site adds `@IsOptional()` where the field may be left out or cleared with null.

/** A type a lift can follow. `rpe` isn't one until per-set RPE logging exists. */
export const IsLiftProgression = () => IsIn(LIFT_PROGRESSION_TYPES);

/** Above 0, like a spec row's increment: a zero increment makes rounding divide by zero. */
export const IsProgressionIncrement = () => applyDecorators(IsNumber(), IsPositive());

/** A whole number of reps within the limits, and at most `atMost` when that sibling is a number. */
export const IsProgressionReps = (atMost?: string) =>
  applyDecorators(
    IsInt(),
    Min(PROGRESSION_REPS_LIMITS.MIN),
    Max(PROGRESSION_REPS_LIMITS.MAX),
    ...(atMost ? [Validate(IsAtMostSibling, [atMost])] : []),
  );
