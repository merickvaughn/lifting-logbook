import { BadRequestException, Logger } from '@nestjs/common';
import { LiftRecord, NamedLift, lookupLift } from '@lifting-logbook/core';
import { LiftModificationMaxMode } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';

const logger = new Logger('LiftModification');

/** The id a new modification is stored against. Plain strings until #1142 adds `LiftId`. */
export function modificationLiftId(name: string, customLifts: readonly NamedLift[]): string | undefined {
  const { builtIn, custom } = lookupLift(name, customLifts);
  return custom?.id ?? builtIn?.id;
}

/**
 * Every id a modification of the lift called `name` may be stored against. A custom lift can share
 * a catalog lift's name, and then `Cable Curl` means the custom lift while `cable-curl` and
 * `Cable Curls` mean the built-in. To the lifter they are one lift, so a modification made under any
 * of those spellings attaches under all of them. `lift_record.lift` holds mixed spellings until #1142.
 */
export function modificationLiftIds(name: string, customLifts: readonly NamedLift[]): ReadonlySet<string> {
  const { builtIn, custom } = lookupLift(name, customLifts);
  const namesake = builtIn && lookupLift(builtIn.name, customLifts).custom;
  return new Set([custom?.id, namesake?.id, builtIn?.id].filter((id) => id !== undefined));
}

/**
 * The write rule for a logged set's modifications: each belongs to this user and to the set's lift,
 * with at most one `own`. Lives above the port, so both adapters get it. Another user's id reads
 * the same as an unknown one, so a 400 reveals nothing. An archived modification still counts, so
 * a set that names one can still be edited.
 *
 * `alreadyOn` is the set's stored list, on an edit. Those ids skip the lift check, because the set
 * attached them when it was logged, and a custom lift renamed since leaves the set under a name
 * that no longer resolves.
 *
 * Returns the names of the user's modifications, for the response.
 */
export async function assertSetModifications(
  repos: Pick<RepositoryBundle, 'customLift' | 'liftModification'>,
  lift: string,
  ids: readonly string[],
  alreadyOn: readonly string[] = [],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const liftIds = modificationLiftIds(lift, await repos.customLift.list());
  const modifications = await repos.liftModification.list();
  const byId = new Map(modifications.map((m) => [m.id, m]));
  let ownMaxes = 0;
  for (const id of ids) {
    const modification = byId.get(id);
    if (!modification || !(alreadyOn.includes(id) || liftIds.has(modification.lift))) {
      throw new BadRequestException(`'${id}' is not one of your modifications of ${lift}`);
    }
    if (modification.maxMode === 'own') ownMaxes += 1;
  }
  if (ownMaxes > 1) {
    // Coded, so the logger shows it as is: it names no id, and it's the reason a lifter can hit
    // by turning on a second one beside an archived one the toggles can't classify (#1152).
    throw new BadRequestException({
      statusCode: 400,
      code: 'one-own-modification',
      message: 'A set can have only one modification with its own max',
      error: 'Bad Request',
    });
  }
  return new Map(modifications.map((m) => [m.id, m.name]));
}

/**
 * The `maxMode` of each of the user's modifications, for `updateMaxes` (#1152). Costs no query when
 * no record has any, like {@link modificationNamesFor}.
 *
 * An id with no row reads as `none` there, so its set moves no max. That's logged by id, since a
 * max that didn't move otherwise leaves nothing to explain it.
 */
export async function modificationModesFor(
  repos: Pick<RepositoryBundle, 'liftModification'>,
  records: readonly Pick<LiftRecord, 'modifications'>[],
): Promise<ReadonlyMap<string, LiftModificationMaxMode>> {
  const ids = records.flatMap((r) => r.modifications ?? []);
  if (ids.length === 0) return new Map();
  const modes = new Map((await repos.liftModification.list()).map((m) => [m.id, m.maxMode]));
  const missing = [...new Set(ids)].filter((id) => !modes.has(id));
  if (missing.length > 0) logger.warn({ missing }, 'A logged set names a lift modification with no row, so it moves no max');
  return modes;
}

/**
 * The names of the modifications `records` carry, for the response mappers. Costs no query when
 * no record has any, so a workout with no modifications reads what it always did.
 *
 * A set can name an id with no row if a delete and a log race, since neither sees the other's
 * uncommitted write. The mappers then leave it out, so it is logged here, by id only.
 */
export async function modificationNamesFor(
  repos: Pick<RepositoryBundle, 'liftModification'>,
  records: readonly Pick<LiftRecord, 'modifications'>[],
): Promise<ReadonlyMap<string, string>> {
  const ids = records.flatMap((r) => r.modifications ?? []);
  if (ids.length === 0) return new Map();
  const names = new Map((await repos.liftModification.list()).map((m) => [m.id, m.name]));
  const missing = [...new Set(ids)].filter((id) => !names.has(id));
  if (missing.length > 0) logger.warn({ missing }, 'A logged set names a lift modification with no row');
  return names;
}
