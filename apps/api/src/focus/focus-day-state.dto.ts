import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  MaxLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { FOCUS_PLACEMENTS, FOCUS_SELECTIONS } from '@lifting-logbook/types';
import type { FocusDayState, FocusPlacement, FocusSelection } from '@lifting-logbook/types';

/** Bounds on a stored day state: a workout has a handful of focus blocks and lifts. */
const MAX_KEYS = 50;
const MAX_ITEMS = 50;
const MAX_ID = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBoundedKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length <= MAX_KEYS && keys.every((key) => key.length <= MAX_ID);
}

function isBoundedStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ITEMS &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_ID)
  );
}

// class-validator has no decorator for a dictionary's values, so the by-block-id records
// are checked whole.
@ValidatorConstraint({ name: 'IsSelectionRecord', async: false })
class IsSelectionRecordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      isPlainObject(value) &&
      hasBoundedKeys(value) &&
      Object.values(value).every((mode) => (FOCUS_SELECTIONS as readonly unknown[]).includes(mode))
    );
  }
  defaultMessage(): string {
    return `modes must map focus block ids to one of: ${FOCUS_SELECTIONS.join(', ')}`;
  }
}

@ValidatorConstraint({ name: 'IsLiftListRecord', async: false })
class IsLiftListRecordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isPlainObject(value) && hasBoundedKeys(value) && Object.values(value).every(isBoundedStringArray);
  }
  defaultMessage(): string {
    return `$property must map focus block ids to lists of at most ${MAX_ITEMS} lift names`;
  }
}

export class FocusDayStateDto implements FocusDayState {
  @Validate(IsSelectionRecordConstraint)
  modes!: Record<string, FocusSelection>;

  @Validate(IsLiftListRecordConstraint)
  picks!: Record<string, string[]>;

  @Validate(IsLiftListRecordConstraint)
  trims!: Record<string, string[]>;

  @IsIn(FOCUS_PLACEMENTS)
  placement!: FocusPlacement;

  // Explicit null: the default order.
  @ValidateIf((o: FocusDayStateDto) => o.order !== null)
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(MAX_ID, { each: true })
  order!: string[] | null;

  @IsBoolean()
  dismissed!: boolean;
}
