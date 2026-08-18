import { IsDateString, IsIn, IsNumber, IsString, Matches, Max, Min } from 'class-validator';
import { RecordBodyWeightRequest } from '@lifting-logbook/types';
import { MAX_WEIGHT } from './lift-record.limits';

// Implements the shared request contract in @lifting-logbook/types. Before this class
// existed, BodyWeightController declared `@Body() body: RecordBodyWeightRequest`
// directly — a plain interface is erased at compile time, so Nest's ValidationPipe
// had no metatype to validate against and silently let any JSON object through
// unchecked (issue #897 — the same gap #893 closed for CreateLiftRecordDto /
// UpdateLiftRecordDto). `implements` catches a required member being removed or
// retyped; it does NOT catch a newly-added *optional* member, which this class would
// then simply omit with no compile error — moot here since every field on
// RecordBodyWeightRequest is required.
export class RecordBodyWeightDto implements RecordBodyWeightRequest {
  /**
   * Bare calendar date, `YYYY-MM-DD`. Always required for this endpoint — unlike
   * CreateLiftRecordDto.date there is no scheduled-date fallback, and every known
   * caller already sends a bare date (`new Date().toISOString().slice(0, 10)` in
   * strength-goals/actions.ts, an `<input type="date">`-sourced value threaded
   * through WorkoutLogger.tsx's `effectiveDate`).
   *
   * Restricted to a bare date for the same reason CreateLiftRecordDto.date was
   * (#893 review round 3): the controller does `new Date(body.date)` unguarded — a
   * date-*only* string parses as UTC midnight per the ES spec, but an
   * offset-bearing or offset-less date-*time* string parses differently (UTC vs.
   * server-local respectively) and can silently shift the stored calendar day.
   * `@Matches` rules out shapes `new Date()` can't parse or silently misparses
   * (e.g. ISO week/ordinal dates); `@IsDateString`'s strict mode rejects
   * shape-valid-but-nonexistent dates (e.g. 2026-02-30, which would otherwise
   * silently roll over to March).
   */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be a calendar date in YYYY-MM-DD format' })
  @IsDateString({ strict: true, strictSeparator: true })
  date!: string;

  // Float, not Int (matches the `weight Float` column). 0 is intentionally not
  // excluded — the same `@Min(0)` bound CreateLiftRecordDto.weight uses — since
  // this DTO has no basis for asserting a stricter floor than the interface's own
  // contract; `@Max` adds the same "catch an obvious garbage value" sanity ceiling
  // #893 established for lift weights, reused here since it's the identical
  // real-world quantity in the identical unit space (lbs/kg).
  @IsNumber()
  @Min(0)
  @Max(MAX_WEIGHT)
  weight!: number;

  @IsString()
  @IsIn(['lbs', 'kg'])
  unit!: 'lbs' | 'kg';
}
