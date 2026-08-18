/**
 * Bounds shared between CreateLiftRecordDto and UpdateLiftRecordDto — both reach the
 * identical `lift_record` columns (create via POST, partial update via PATCH), so a
 * one-sided change to either DTO would silently let POST create a record PATCH
 * cannot produce, or vice versa. Centralized here after that exact drift risk was
 * flagged during #893's review.
 *
 * MAX_WEIGHT is additionally reused by RecordBodyWeightDto and TrainingMaxEntryDto
 * (issue #897) — same real-world quantity (a weight in lbs/kg) reached through
 * different endpoints, so one shared sanity ceiling avoids near-duplicate magic
 * numbers drifting apart across the three DTOs.
 */

// Generous but finite — comfortably above any recorded raw lift, in lbs or kg. Exists
// only to catch an obvious garbage value (e.g. a stray extra digit), not to constrain
// legitimate extreme performance.
export const MAX_WEIGHT = 10000;

// `reps` is a Postgres `Int` column (32-bit) — without an upper bound, a value like
// 3_000_000_000 passes validation and then fails at the database layer as an
// unhandled 500 (verified against real Postgres). 1000 is far beyond any realistic
// single-set rep count.
export const MAX_REPS = 1000;

// Matches the nearest precedent for a free-text field in this controller family
// (workout-skip.controller.ts's SkipWorkoutDto.reason).
export const MAX_NOTES_LENGTH = 500;
