import { BadRequestException } from '@nestjs/common';
import { LiftRecord, NamedLift, lookupLift } from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';

/**
 * The id a modification is stored against. `lift_record.lift` holds mixed spellings, so this is
 * also how a set is checked against a modification's lift. Plain strings until #1142 adds `LiftId`.
 */
export function modificationLiftId(name: string, customLifts: readonly NamedLift[]): string | undefined {
  const { builtIn, custom } = lookupLift(name, customLifts);
  return custom?.id ?? builtIn?.id;
}

/**
 * The write rule for a logged set's modifications: each belongs to this user and to the set's lift,
 * with at most one `own`. Lives above the port, so both adapters get it. Another user's id reads
 * the same as an unknown one, so a 400 reveals nothing. An archived modification still counts, so
 * a set that names one can still be edited, and a page open across the delete can still log.
 */
export async function assertSetModifications(
  repos: Pick<RepositoryBundle, 'customLift' | 'liftModification'>,
  lift: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const liftId = modificationLiftId(lift, await repos.customLift.list());
  const byId = new Map((await repos.liftModification.list()).map((m) => [m.id, m]));
  let ownMaxes = 0;
  for (const id of ids) {
    const modification = byId.get(id);
    if (!modification || modification.lift !== liftId) {
      throw new BadRequestException(`'${id}' is not one of your modifications of ${lift}`);
    }
    if (modification.maxMode === 'own') ownMaxes += 1;
  }
  if (ownMaxes > 1) {
    throw new BadRequestException('A set can have only one modification with its own max');
  }
}

/**
 * The names of the modifications `records` carry, for the response mappers. Costs no query when
 * no record has any, so a workout with no modifications reads what it always did.
 */
export async function modificationNamesFor(
  repos: Pick<RepositoryBundle, 'liftModification'>,
  records: readonly Pick<LiftRecord, 'modifications'>[],
): Promise<ReadonlyMap<string, string>> {
  if (!records.some((r) => r.modifications?.length)) return new Map();
  return new Map((await repos.liftModification.list()).map((m) => [m.id, m.name]));
}
