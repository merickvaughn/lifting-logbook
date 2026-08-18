import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { UpdateTrainingMaxesRequest } from '@lifting-logbook/types';
import { MAX_WEIGHT } from './lift-record.limits';

// One entry of the `maxes` array. Validated via @ValidateNested({ each: true }) +
// @Type below on UpdateTrainingMaxesDto — see CreateCustomProgramDto's `specs` field
// (apps/api/src/custom-programs/create-custom-program.dto.ts) for the same
// array-of-DTO pattern.
export class TrainingMaxEntryDto {
  // Trimmed before validation, same rationale as CreateLiftRecordDto.lift (#893
  // review round 3): TrainingMaxesController.updateTrainingMaxes merges incoming
  // entries into the existing set by exact string match
  // (`incomingMap.has(m.lift)` / `merged.some((m) => m.lift === incoming.lift)`),
  // so an untrimmed "Squat " would silently fail to match the existing "Squat"
  // entry and get appended as a spurious duplicate rather than updating it — the
  // `@@unique([userId, program, lift])` constraint doesn't catch this since the two
  // strings are literally different values. `whitelist: true` in this repo's
  // ValidationPipeOptions makes the pipe return the transformed entity
  // (classToPlain path — see validation.pipe.js's `shouldTransformToPlain` check)
  // even though `transform` itself isn't set, so this @Transform does take effect
  // on what the controller receives, not just on what gets validated. `toClassOnly`
  // scopes it to the plainToClass direction only — class-transformer also runs
  // @Transform on the classToPlain leg of the same round trip (the mechanism that
  // makes the trim reach the controller at all — see above), and without
  // `toClassOnly` an idempotent `.trim()` happens to be harmless run twice, but
  // that's incidental, not by design; scoping it explicitly means a future
  // non-idempotent transform added here won't silently double-apply.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value), {
    toClassOnly: true,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lift!: string;

  // Float, not Int (matches the `weight Float` column). Must be > 0 — matching the
  // client's own validation (TrainingMaxesForm.tsx rejects `n <= 0` with "Enter a
  // positive number" before ever calling this endpoint) rather than
  // CreateLiftRecordDto's `@Min(0)`, which is deliberately looser there for a
  // *lift's added* weight (legitimately 0 for bodyweight-only exercises) — a
  // training max of 0 has no such meaning, and a 0 max makes every derived
  // working/warm-up weight for that lift compute to 0 with no error anywhere.
  // `@Max` reuses the same sanity ceiling #893 established for lift weights — the
  // identical real-world quantity (a weight in lbs/kg) reached through a different
  // endpoint.
  @IsNumber()
  @IsPositive()
  @Max(MAX_WEIGHT)
  weight!: number;

  /**
   * Deliberately narrower than the shared `WeightUnit`/`WEIGHT_UNIT_OPTIONS` (which
   * also allow `'kg'`) — restricted to `'lbs'` only, unlike RecordBodyWeightDto.unit
   * (issue #897 review). `TrainingMax` (packages/core) has no `unit` field at all,
   * and `TrainingMaxesController.updateTrainingMaxes` never reads `body.maxes[].unit`
   * — only `lift`/`weight` reach `incomingMap`/`merged` — while
   * `toTrainingMaxResponse` (./mappers.ts) unconditionally reports `unit: 'lbs'` in
   * every response regardless of what was sent. Before this DTO existed, an
   * unvalidated `unit: 'kg'` was silently *ignored*; validating it as a declared,
   * accepted part of the contract without also honoring it would be strictly worse —
   * a client sending `{lift:'Squat', weight:140, unit:'kg'}` would get a 200 back
   * claiming `{weight:140, unit:'lbs'}`, silently mislabeling (not converting) a
   * 140 kg max as 140 lbs. Same principle CreateLiftRecordDto.program's doc comment
   * established for a mismatched value: "a silently-discarded-on-mismatch field is a
   * worse trap than an ignored one, once it's a declared part of the validated
   * contract" — rejecting the value the server cannot honor is the safer contract
   * until TrainingMax gains real per-entry unit storage (tracked separately).
   * TrainingMaxesForm.tsx (apps/web) already only ever sends 'lbs' in practice (its
   * per-row `unit` always derives from a prior response, which is always 'lbs'), so
   * this does not change real-client behavior.
   */
  @IsIn(['lbs'])
  unit!: 'lbs';
}

// Implements the shared request contract in @lifting-logbook/types. Before this
// class existed, TrainingMaxesController declared `@Body() body:
// UpdateTrainingMaxesRequest` directly — a plain interface is erased at compile
// time, so Nest's ValidationPipe had no metatype to validate against and silently
// let any JSON object through unchecked. In particular, a body with no `maxes` key
// (or a non-array `maxes`) reached `body.maxes.map(...)` unguarded and crashed with
// an unhandled 500 (TypeError: Cannot read properties of undefined) rather than a
// clean 400 (issue #897 — the same gap #893 closed for CreateLiftRecordDto /
// UpdateLiftRecordDto).
export class UpdateTrainingMaxesDto implements UpdateTrainingMaxesRequest {
  // ArrayMaxSize guards against an unbounded request: each entry becomes one
  // `db.trainingMax.upsert` inside a single batched transaction
  // (PrismaTrainingMaxRepository.saveTrainingMaxes → runBatch), run sequentially, so
  // an unbounded `maxes` array is an unbounded statement count in one transaction —
  // a real DoS-adjacent cost (RLS transaction timeout, a pinned DB connection) for a
  // request Fastify's default 1 MiB body limit does nothing to prevent (tens of
  // thousands of small JSON objects fit easily). The built-in catalog (LIFT_NAMES)
  // has 12 entries; 100 leaves generous headroom for custom lifts while still
  // bounding the worst case. Every other nested-array DTO in apps/api carries a
  // bound (patch-lift-metadata.dto.ts, movement-profile.dto.ts,
  // update-settings.dto.ts) — this one had none before #897's review caught it.
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TrainingMaxEntryDto)
  maxes!: TrainingMaxEntryDto[];
}
