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

/**
 * Shared `@Matches` + `@IsDateString` pairing for a "bare calendar date, no time/offset
 * component" field — originally established on CreateLiftRecordDto.date (#893 review
 * round 3) and reused verbatim by RecordBodyWeightDto.date (#897), both of which reach
 * a bare `new Date(body.date)` (directly, or via `toUTCMidnight`) with no other guard.
 * A date-*only* string parses as UTC midnight per the ES spec; an offset-bearing or
 * offset-less date-*time* string parses differently (UTC vs. server-local
 * respectively) and can silently shift the stored calendar day. `BARE_DATE_PATTERN`
 * rules out shapes `new Date()` can't parse or silently misparses (e.g. ISO 8601
 * week/ordinal dates); `BARE_DATE_STRING_OPTIONS`'s strict mode rejects
 * shape-valid-but-nonexistent dates (e.g. 2026-02-30, which would otherwise silently
 * roll over to March). Centralized here — rather than each call site re-declaring its
 * own copy — so a future relaxation of one date field doesn't silently diverge from
 * the others reaching the same kind of unguarded `new Date(string)` call.
 *
 * Usage: `@Matches(BARE_DATE_PATTERN, { message: BARE_DATE_MESSAGE })` followed by
 * `@IsDateString(BARE_DATE_STRING_OPTIONS)`.
 */
export const BARE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const BARE_DATE_MESSAGE = 'date must be a calendar date in YYYY-MM-DD format';
export const BARE_DATE_STRING_OPTIONS = { strict: true, strictSeparator: true } as const;

// `reps` is a Postgres `Int` column (32-bit) — without an upper bound, a value like
// 3_000_000_000 passes validation and then fails at the database layer as an
// unhandled 500 (verified against real Postgres). 1000 is far beyond any realistic
// single-set rep count.
export const MAX_REPS = 1000;

// Matches the nearest precedent for a free-text field in this controller family
// (workout-skip.controller.ts's SkipWorkoutDto.reason).
export const MAX_NOTES_LENGTH = 500;
