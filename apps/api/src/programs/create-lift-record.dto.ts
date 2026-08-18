import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CreateLiftRecordRequest } from '@lifting-logbook/types';
import { MAX_NOTES_LENGTH, MAX_REPS, MAX_WEIGHT } from './lift-record.limits';

// Implements the shared request contract in @lifting-logbook/types for every field
// except `program` (see below). For the rest, `implements` catches a required member
// being removed or retyped — it does NOT catch a newly-added *optional* member, which
// this class would then simply omit with no compile error. Before this class existed,
// the controller declared `@Body() body: CreateLiftRecordRequest` directly — a plain
// interface is erased at compile time, so Nest's ValidationPipe had no metatype to
// validate against and silently let any JSON object through unchecked (issue #893).
export class CreateLiftRecordDto
  implements Omit<CreateLiftRecordRequest, 'program'>, Partial<Pick<CreateLiftRecordRequest, 'program'>>
{
  // Optional here even though the shared interface marks it required: the handler
  // never reads `body.program` for the write itself — the route's `:program` param is
  // authoritative — but LiftRecordsController.createLiftRecord now rejects a request
  // whose body.program *conflicts* with the route param (issue #893 review round 3:
  // a silently-discarded-on-mismatch field is a worse trap than an ignored one, once
  // it's a declared part of the validated contract). Optional because existing
  // callers are inconsistent about sending it at all; still declared (and
  // type-checked when present) so clients that do send it — matching the documented
  // interface — aren't rejected by `forbidNonWhitelisted` (main.ts's global
  // ValidationPipe).
  @IsOptional()
  @IsString()
  program?: string;

  // Upper bounds are generous (well beyond any realistic program length) — they exist
  // to turn an obvious client bug (a stray digit, an off-by-orders-of-magnitude loop
  // index) into a clean 400 at the boundary instead of silently storing garbage that
  // only surfaces later as a broken dashboard/week layout. Mirrors the precedent set
  // by CustomProgramSpecRowDto's @Max(20) on `sets`/`reps` for the same controller
  // family's structural fields. These bounds apply to this direct-write endpoint only
  // — the CSV import path (importLiftRecords → parseLiftRecords/validateLiftImport)
  // has its own, separate, looser validation and is untouched by this DTO.
  @IsInt()
  @Min(1)
  @Max(1000)
  cycleNum!: number;

  @IsInt()
  @Min(1)
  @Max(1000)
  workoutNum!: number;

  /**
   * Bare calendar date, `YYYY-MM-DD`. When omitted (or an empty string — see the
   * `@Transform` below) the server uses the scheduled date for this workout, falling
   * back to today.
   *
   * Restricted to a bare date — no time/offset component — after #893's review round
   * 3 found that accepting one was actively unsafe: the controller normalizes via
   * `toUTCMidnight(new Date(body.date))`, which reads *UTC* components, so an
   * offset-bearing value silently shifts to a different calendar day (verified:
   * `2026-05-01T23:30:00-07:00` stores as `2026-05-02`), and an offset-less
   * date-time is parsed in the *server's local* timezone per the ES spec, so the
   * same request stores a different day on a local dev box vs. Cloud Run. `date` is
   * part of both the `@@unique` natural key and the public id (issue #884), so
   * either failure mode silently files the record under the wrong day.
   *
   * `@Matches` and `@IsDateString({ strict: true, strictSeparator: true })` overlap
   * deliberately: validator.js's `isISO8601`, even strict, still accepts the ISO
   * 8601 week-date (`2026-W05`) and ordinal-date (`2026-001`) forms that
   * `new Date(...)` can't parse or silently misparses — `@Matches` rules those out by
   * shape; `@IsDateString`'s strict mode then rejects shape-valid-but-nonexistent
   * dates (`2026-02-30`, which would otherwise silently roll over to March). See also
   * the defensive `Number.isNaN` guard in LiftRecordsController.createLiftRecord,
   * scoped to this field specifically, as a last-resort backstop against a future
   * validator-library quirk in either decorator.
   *
   * The `@Transform` maps an empty string to `undefined` before validation runs, so
   * `date: ''` — what `<input type="date">` sends when cleared, per
   * WorkoutLogger.tsx — is treated as "not provided" (falls back to the scheduled
   * date) rather than rejected, matching the controller's own `if (body.date)`
   * truthiness check, which already treated `''` that way before this DTO existed.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be a calendar date in YYYY-MM-DD format' })
  @IsDateString({ strict: true, strictSeparator: true })
  date?: string;

  // Trimmed before validation: an untrimmed value (e.g. "Bench Press " from a stray
  // trailing space) is a *different* natural key / id-path-segment than the
  // canonical trimmed name (packages/core/src/utils/import/liftRecordNaturalKey.ts),
  // so it would silently fragment one lift's history across two string variants
  // rather than colliding with (and being caught as a duplicate of) the real record.
  // Trimming also means a whitespace-only value becomes `''` and is caught by
  // @IsNotEmpty below, rather than needing a separate pattern check.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lift!: string;

  // 50, not CustomProgramSpecRowDto's 20 — this is logged performance data (warm-ups,
  // drop sets, extra work) rather than a prescribed program spec, so it needs more
  // headroom, but still bounded to catch an obvious bug rather than left unbounded.
  @IsInt()
  @Min(1)
  @Max(50)
  setNum!: number;

  // Float, not Int (matches the `weight Float` column) — fractional plate loads
  // (e.g. 182.5 lbs) are valid. 0 is allowed for bodyweight-only exercises.
  @IsNumber()
  @Min(0)
  @Max(MAX_WEIGHT)
  weight!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_REPS)
  reps!: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_NOTES_LENGTH)
  notes?: string;
}
