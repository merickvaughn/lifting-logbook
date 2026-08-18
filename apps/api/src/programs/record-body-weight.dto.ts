import { IsDateString, IsIn, IsNumber, IsPositive, Matches, Max } from 'class-validator';
import { RecordBodyWeightRequest, WeightUnit, WEIGHT_UNIT_OPTIONS } from '@lifting-logbook/types';
import { BARE_DATE_MESSAGE, BARE_DATE_PATTERN, BARE_DATE_STRING_OPTIONS, MAX_WEIGHT } from './lift-record.limits';

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
   * CreateLiftRecordDto.date there is no scheduled-date fallback. Every *submitting*
   * caller sends a bare date (`new Date().toISOString().slice(0, 10)` in
   * strength-goals/actions.ts; WorkoutLogger.tsx's `effectiveDate`, sourced from an
   * `<input type="date">`) — though that same input is user-clearable to `''`, which
   * this DTO now rejects with a clean 400 rather than the pre-#897 behavior of
   * reaching `new Date('')` (Invalid Date) and 500ing downstream in
   * `getLatestBodyWeight`'s `entry.date.toISOString()`. A net improvement on the
   * failure mode, but the client still has no graceful handling for a cleared date —
   * out of scope here (validation, not UX).
   *
   * Restricted to a bare date for the same reason CreateLiftRecordDto.date was
   * (#893 review round 3): the controller does `new Date(body.date)` unguarded — see
   * BARE_DATE_PATTERN's doc comment in ./lift-record.limits for the full rationale.
   */
  @Matches(BARE_DATE_PATTERN, { message: BARE_DATE_MESSAGE })
  @IsDateString(BARE_DATE_STRING_OPTIONS)
  date!: string;

  // Float, not Int (matches the `weight Float` column). Must be > 0 — matching the
  // client's own validation (WorkoutLogger.tsx's handleBodyWeightSubmit rejects
  // `weight <= 0` before ever calling this endpoint) rather than CreateLiftRecordDto's
  // `@Min(0)`, which is deliberately looser there because a *lift's added* weight can
  // legitimately be 0 (bodyweight-only exercises) — a body-weight *observation* of 0
  // has no such meaning. `@Max` adds the same "catch an obvious garbage value" sanity
  // ceiling #893 established for lift weights, reused here since it's the identical
  // real-world quantity in the identical unit space (lbs/kg).
  @IsNumber()
  @IsPositive()
  @Max(MAX_WEIGHT)
  weight!: number;

  // `@IsIn` alone (no `@IsString`) matches the established precedent in
  // update-settings.dto.ts's `unit?: WeightUnit | null` — membership in a fixed set of
  // string literals already fully constrains the type, so `@IsString` is redundant.
  // Sourced from the shared WEIGHT_UNIT_OPTIONS rather than a hardcoded
  // ['lbs', 'kg'] literal so this can't silently drift from the real source of truth
  // if WeightUnit ever grows a third unit — a hardcoded array wouldn't be caught by
  // `implements`, since a *narrower* property type is still assignable to the wider
  // interface member it satisfies.
  @IsIn(WEIGHT_UNIT_OPTIONS)
  unit!: WeightUnit;
}
