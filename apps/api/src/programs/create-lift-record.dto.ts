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
import { CreateLiftRecordRequest } from '@lifting-logbook/types';

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
  // never reads `body.program` — the route's `:program` param is authoritative (see
  // LiftRecordsController.createLiftRecord) — and existing callers are inconsistent
  // about sending it. Requiring it would reject otherwise-valid requests for a field
  // the server doesn't use. Still declared (and still type-checked when present) so
  // clients that do send it — matching the documented interface — aren't rejected by
  // `forbidNonWhitelisted` (main.ts's global ValidationPipe).
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
   * Calendar date, optionally with a time component (e.g. `2026-05-01` or
   * `2026-05-01T10:30:00Z`). When omitted the server uses the scheduled date for
   * this workout, falling back to today.
   *
   * Two decorators, deliberately: `@IsDateString({ strict: true, strictSeparator:
   * true })` alone is not sufficient — validator.js's `isISO8601` (what
   * `@IsDateString` wraps), even in strict mode, still accepts the ISO 8601
   * week-date (`2026-W05`) and ordinal-date (`2026-001`) forms, which `new Date(...)`
   * either can't parse (`Invalid Date`) or silently misparses as a different day
   * (verified: `2026-001` → Jan 1, not week 1 of the intended date). `@Matches`
   * constrains the shape to what the controller's `new Date(body.date)` call can
   * actually consume; `@IsDateString` with strict options then rejects
   * shape-valid-but-nonexistent calendar dates (`2026-02-30`, which would otherwise
   * silently roll over to March). Found and both gaps closed during #893's review —
   * see also the defensive `Number.isNaN` guard in
   * LiftRecordsController.createLiftRecord, which exists specifically so a future
   * validator-library quirk in either of these can never reach the persistence layer
   * as an `Invalid Date` again.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}(T.*)?$/, {
    message: 'date must be a calendar date (YYYY-MM-DD) optionally followed by a time component',
  })
  @IsDateString({ strict: true, strictSeparator: true })
  date?: string;

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
  // (e.g. 182.5 lbs) are valid. 0 is allowed for bodyweight-only exercises. Upper
  // bound is generous (comfortably above any recorded raw lift, in lbs or kg) —
  // exists only to catch an obvious garbage value (e.g. a stray extra digit), not to
  // constrain legitimate extreme performance.
  @IsNumber()
  @Min(0)
  @Max(10000)
  weight!: number;

  // `reps` is a Postgres `Int` column (32-bit) — without an upper bound here, a
  // value like 3_000_000_000 passes validation and then fails at the database layer
  // as an unhandled 500 (verified against real Postgres during #893's review; the
  // in-memory test adapter does not reproduce this, since it has no column-width
  // constraint — the DB-backed e2e suite is what actually exercises it). 1000 is far
  // beyond any realistic single-set rep count.
  @IsInt()
  @Min(1)
  @Max(1000)
  reps!: number;

  // 500 matches the nearest precedent for a free-text field in this controller
  // family (workout-skip.controller.ts's SkipWorkoutDto.reason).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
