/**
 * Framework-agnostic errors raised by port adapters. Controllers (or an
 * exception filter) translate these to HTTP responses so that adapters stay
 * free of `@nestjs/common` imports and can be reused by non-HTTP callers
 * (queue workers, CLI tools, alternate transports).
 */

import { FOCUS_BLOCK_STALE_CODE } from '@lifting-logbook/types';

export class ProgramNotFoundError extends Error {
  constructor(public readonly program: string) {
    super(`Program '${program}' not found`);
    this.name = 'ProgramNotFoundError';
  }
}

export class WorkoutNotFoundError extends Error {
  constructor(
    public readonly program: string,
    public readonly macrocycleNum: number,
    public readonly workoutNum: number,
  ) {
    super(
      `Workout ${workoutNum} for program '${program}' macrocycle ${macrocycleNum} not found`,
    );
    this.name = 'WorkoutNotFoundError';
  }
}

export class HistoryEntryNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`History entry '${id}' not found`);
    this.name = 'HistoryEntryNotFoundError';
  }
}

export class StrengthGoalNotFoundError extends Error {
  constructor(public readonly lift: string) {
    super(`Strength goal for lift '${lift}' not found`);
    this.name = 'StrengthGoalNotFoundError';
  }
}

export class CustomLiftNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Custom lift '${id}' not found`);
    this.name = 'CustomLiftNotFoundError';
  }
}

export class CustomLiftConflictError extends Error {
  constructor(public readonly liftName: string) {
    super(`A custom lift named '${liftName}' already exists`);
    this.name = 'CustomLiftConflictError';
  }
}

export class LiftModificationNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Lift modification '${id}' not found`);
    this.name = 'LiftModificationNotFoundError';
  }
}

export class LiftModificationConflictError extends Error {
  constructor(public readonly modificationName: string) {
    super(`This lift already has a modification named '${modificationName}'`);
    this.name = 'LiftModificationConflictError';
  }
}

export class FocusBlockNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Focus block '${id}' not found`);
    this.name = 'FocusBlockNotFoundError';
  }
}

export class FocusBlockConflictError extends Error {
  constructor(
    public readonly series: string,
    public readonly start: string,
  ) {
    super(`Focus block series '${series}' already has a focus block starting ${start}`);
    this.name = 'FocusBlockConflictError';
  }
}

/**
 * A focus block update named a `version` that isn't the block's current one: the block was
 * written after the client read it, and saving would overwrite that write (ADR-039,
 * Amendment 7). Nothing is written.
 */
export class FocusBlockStaleError extends Error {
  readonly code = FOCUS_BLOCK_STALE_CODE;

  constructor(
    public readonly id: string,
    public readonly sent: number,
    public readonly current: number,
  ) {
    super(`Focus block '${id}' changed since it was read: version ${sent} was sent, ${current} is stored`);
    this.name = 'FocusBlockStaleError';
  }
}

/**
 * A program already has a macrocycle with this number, usually one a concurrent request
 * created between this request's read and its insert (ADR-042), or a renumbering found a stored
 * row on a number it needed (#1199; `macrocycleNum` unknown). The request transaction rolls
 * back, so nothing is written.
 */
export class MacrocycleNumberConflictError extends Error {
  readonly code = 'macrocycle-number-taken';

  constructor(
    public readonly program: string,
    public readonly macrocycleNum?: number,
    /**
     * What blocked it, for logs and spans: the table, its number, the database error. `inserting`
     * marks new macrocycles that collided, rather than a renumbering.
     */
    public readonly detail?: { table?: string; heldNumber?: number; cause?: unknown; inserting?: boolean },
  ) {
    super(
      macrocycleNum !== undefined
        ? `Program '${program}' already has a macrocycle ${macrocycleNum}. Reload and try again.`
        : detail?.inserting
          ? `Program '${program}' already has a macrocycle on a number the new ones need. Reload and try again.`
          : `Program '${program}' couldn't be renumbered: a stored row already has a number it needs. Reload and try again.`,
    );
    this.name = 'MacrocycleNumberConflictError';
  }
}

// Distinct from CustomLiftConflictError: reusing that error's message for a
// name that case-insensitively shadows a built-in canonical alias asserted
// something false — no custom lift by that name exists — and made this
// endpoint's 409 mean two different things with no way to tell them apart
// from the response alone (issue #911 review, third pass).
export class ReservedLiftNameConflictError extends Error {
  constructor(public readonly liftName: string) {
    super(`'${liftName}' is a reserved lift name and cannot be used for a custom lift`);
    this.name = 'ReservedLiftNameConflictError';
  }
}
