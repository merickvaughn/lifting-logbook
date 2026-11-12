import { BadRequestException, Logger } from '@nestjs/common';
import { LiftRecord, ModificationMax, NamedLift, lookupLift } from '@lifting-logbook/core';
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

/** What `updateMaxes` and {@link saveOwnMaxes} need to know of the user's modifications. */
export interface ModificationModes {
  /** Each modification's `maxMode` (#1152). */
  modes: ReadonlyMap<string, LiftModificationMaxMode>;
  /** Each modification's lift id, which an own max's history entry is filed under (#1153). */
  lifts: ReadonlyMap<string, string>;
}

/**
 * The `maxMode` and lift of each of the user's modifications, for `updateMaxes` (#1152). Costs no
 * query when no record has any, like {@link modificationNamesFor}.
 *
 * An id with no row reads as `none` there, so its set moves no max. That's logged by id, since a
 * max that didn't move otherwise leaves nothing to explain it.
 */
export async function modificationModesFor(
  repos: Pick<RepositoryBundle, 'liftModification'>,
  records: readonly Pick<LiftRecord, 'modifications'>[],
): Promise<ModificationModes> {
  const ids = records.flatMap((r) => r.modifications ?? []);
  if (ids.length === 0) return { modes: new Map(), lifts: new Map() };
  const modifications = await repos.liftModification.list();
  const modes = new Map(modifications.map((m) => [m.id, m.maxMode]));
  const missing = [...new Set(ids)].filter((id) => !modes.has(id));
  if (missing.length > 0) logger.warn({ missing }, 'A logged set names a lift modification with no row, so it moves no max');
  return { modes, lifts: new Map(modifications.map((m) => [m.id, m.lift])) };
}

/**
 * The program's own maxes, for `updateMaxes` (#1153). Read only when a record carries an `own`
 * modification, so a macrocycle with none costs no query.
 */
export async function ownMaxesFor(
  repos: Pick<RepositoryBundle, 'liftModification'>,
  program: string,
  records: readonly Pick<LiftRecord, 'modifications'>[],
  modes: ReadonlyMap<string, LiftModificationMaxMode>,
): Promise<ModificationMax[]> {
  const anyOwn = records.some((r) => (r.modifications ?? []).some((id) => modes.get(id) === 'own'));
  return anyOwn ? repos.liftModification.getMaxes(program) : [];
}

/**
 * Saves the own maxes `updateMaxes` moved or created, and a history entry for each whose weight
 * changed, marked with its modification so the lift's history reads leave it out (#1153).
 *
 * `lifts` is {@link modificationModesFor}'s. Every own max `updateMaxes` moves belongs to a
 * modification it read as `own` there, so each has a lift.
 */
export async function saveOwnMaxes(
  repos: Pick<RepositoryBundle, 'liftModification' | 'trainingMaxHistory'>,
  program: string,
  lifts: ReadonlyMap<string, string>,
  before: readonly ModificationMax[],
  after: readonly ModificationMax[],
  date: Date,
  source: 'test' | 'program',
): Promise<void> {
  const previous = new Map(before.map((m) => [m.modificationId, m]));
  const changed = after.filter((m) => {
    const was = previous.get(m.modificationId);
    return !was || was.weight !== m.weight || was.dateUpdated.getTime() !== m.dateUpdated.getTime();
  });
  if (changed.length === 0) return;
  await repos.liftModification.saveMaxes(program, changed);

  const moved = changed.filter((m) => previous.get(m.modificationId)?.weight !== m.weight);
  if (moved.length === 0) return;
  await repos.trainingMaxHistory.appendHistoryEntries(
    program,
    moved.map((m) => ({
      lift: liftOfModification(lifts, m.modificationId),
      weight: m.weight,
      reps: 1,
      date,
      isPR: false,
      source,
      goalMet: false,
      modificationId: m.modificationId,
    })),
  );
}

function liftOfModification(lifts: ReadonlyMap<string, string>, modificationId: string): string {
  const lift = lifts.get(modificationId);
  // Unreachable while `saveOwnMaxes` gets its caller's `modificationModesFor` lifts. Throwing rolls
  // the request back, rather than file history under no lift.
  if (lift === undefined) throw new Error(`Own max moved for modification ${modificationId}, which has no lift`);
  return lift;
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
