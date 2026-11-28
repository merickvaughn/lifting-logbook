import { storedIdListing } from '@lifting-logbook/core';

export type CustomLiftName = { id: string; name: string };

/**
 * What to list and show each stored `lift` as: a custom lift's name for its id, which import
 * stores its sets under (#1290, #1503), otherwise `storedIdListing`'s name.
 */
export function liftListing(names: Iterable<string>, customLifts: readonly CustomLiftName[]): (name: string) => string {
  const custom = new Map(customLifts.map((lift) => [lift.id, lift.name]));
  const listing = storedIdListing(names);
  return (name) => custom.get(name) ?? listing(name);
}
