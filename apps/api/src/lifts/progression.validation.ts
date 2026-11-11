import { ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

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
