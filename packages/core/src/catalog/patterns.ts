import type { MovementTag } from '@lifting-logbook/types';
import { lookupLift, type NamedLift } from './builtInLift';

/**
 * The rows of a weekly sets-by-movement-pattern breakdown, in display order.
 *
 * Direction rows come from a lift's push/pull + vertical/horizontal tags, measured
 * relative to the torso (see `LIFT_CATALOG`). A lift with neither a direction nor a
 * squat, hinge or carry pattern — curls, raises — counts as "Isolation / other".
 */
export const MOVEMENT_PATTERN_ROWS = [
  'Horizontal Push',
  'Vertical Push',
  'Horizontal Pull',
  'Vertical Pull',
  'Squat',
  'Hinge',
  'Carry',
  'Isolation / other',
] as const;

export type MovementPatternRow = (typeof MOVEMENT_PATTERN_ROWS)[number];

const DIRECTION_ROWS = {
  push: { horizontal: 'Horizontal Push', vertical: 'Vertical Push' },
  pull: { horizontal: 'Horizontal Pull', vertical: 'Vertical Pull' },
} as const satisfies Record<'push' | 'pull', Record<'horizontal' | 'vertical', MovementPatternRow>>;

/**
 * The slice of a custom lift {@link movementPatternsFor} needs. Structural, like
 * `ClassifiableLift`, so both `CustomLiftResponse` and the `CustomLift` domain object
 * satisfy it.
 */
export interface PatternedLift extends NamedLift {
  movementProfile: { patterns: readonly MovementTag[] };
}

/**
 * The pattern rows a lift with these tags counts toward. A set counts once toward each.
 *
 * A direction row needs exactly one of push/pull **and** exactly one of
 * vertical/horizontal; an ambiguous combination (push + pull) earns no direction row
 * rather than a guessed one. Squat, hinge and carry each add their own row. A lift that
 * earns no row is "Isolation / other", so its sets are still shown.
 */
export function movementPatternRowsFor(patterns: readonly MovementTag[]): MovementPatternRow[] {
  const has = (tag: MovementTag) => patterns.includes(tag);
  const rows: MovementPatternRow[] = [];

  const push = has('push');
  const pull = has('pull');
  const vertical = has('vertical');
  const horizontal = has('horizontal');
  if (push !== pull && vertical !== horizontal) {
    rows.push(DIRECTION_ROWS[push ? 'push' : 'pull'][vertical ? 'vertical' : 'horizontal']);
  }
  if (has('squat')) rows.push('Squat');
  if (has('hinge')) rows.push('Hinge');
  if (has('carry')) rows.push('Carry');

  return rows.length > 0 ? rows : ['Isolation / other'];
}

/**
 * The pattern rows a workout's lift name counts toward, under the same precedence as
 * `liftClassificationFor` (see `lookupLift`): a reserved slot name always means the
 * built-in; any other name prefers a custom lift with that exact name or id, whose tags
 * the user recorded. `undefined` means the lift is unknown — the caller reports it as not
 * counted rather than filing it under "Isolation / other".
 */
export function movementPatternsFor(
  name: string,
  customLifts: readonly PatternedLift[] = [],
): MovementPatternRow[] | undefined {
  const { builtIn, custom } = lookupLift(name, customLifts);
  const profile = custom?.movementProfile ?? builtIn?.movementProfile;
  return profile ? movementPatternRowsFor(profile.patterns) : undefined;
}
