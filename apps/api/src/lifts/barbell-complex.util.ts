import { NamedLift, canonicalAliasFor, lookupLift } from '@lifting-logbook/core';
import { modificationLiftId } from './lift-modification.util';

/**
 * How a complex component stores the lift called `name`, or `undefined` when it names no lift. A
 * catalog lift keeps the name it was given, which any spelling of its max resolves from
 * (`currentMaxLookup`). A custom lift is stored by its id, where its training max is kept (#1291),
 * and which a rename doesn't change.
 */
export function complexComponentLift(name: string, customLifts: readonly NamedLift[]): string | undefined {
  if (modificationLiftId(name, customLifts) === undefined) return undefined;
  return lookupLift(name, customLifts).custom?.id ?? name;
}

/**
 * Whether `name` is a lift's name, which a complex can't take: the timer and a lift's settings find
 * a lift by the name a plan shows, so a complex called `Squat` would read as the lift. Case is
 * ignored (#1506), as it is for a custom lift's name, so `squat` counts too.
 */
export function isLiftName(name: string, customLifts: readonly NamedLift[]): boolean {
  const lower = name.toLowerCase();
  return (
    modificationLiftId(name, customLifts) !== undefined ||
    canonicalAliasFor(name) !== undefined ||
    customLifts.some((lift) => lift.name.toLowerCase() === lower)
  );
}
