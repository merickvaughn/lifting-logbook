/**
 * Framework-agnostic errors raised by port adapters. Controllers (or an
 * exception filter) translate these to HTTP responses so that adapters stay
 * free of `@nestjs/common` imports and can be reused by non-HTTP callers
 * (queue workers, CLI tools, alternate transports).
 */

export class ProgramNotFoundError extends Error {
  constructor(public readonly program: string) {
    super(`Program '${program}' not found`);
    this.name = 'ProgramNotFoundError';
  }
}

export class WorkoutNotFoundError extends Error {
  constructor(
    public readonly program: string,
    public readonly cycleNum: number,
    public readonly workoutNum: number,
  ) {
    super(
      `Workout ${workoutNum} for program '${program}' cycle ${cycleNum} not found`,
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

// Distinct from CustomLiftConflictError: reusing that error's message for a
// name that case-insensitively shadows a built-in canonical alias asserted
// something false — no custom lift by that name exists — and made this
// endpoint's 409 mean two different things with no way to tell them apart
// from the response alone (issue #911 review, third pass).
export class ReservedLiftNameConflictError extends Error {
  constructor(public readonly liftName: string) {
    super(`'${liftName}' is a reserved exercise name and cannot be used for a custom exercise`);
    this.name = 'ReservedLiftNameConflictError';
  }
}
