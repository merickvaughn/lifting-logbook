import { IsArray, IsIn, IsNotEmpty, IsNumber, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
  // on what the controller receives, not just on what gets validated.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lift!: string;

  // Float, not Int (matches the `weight Float` column). @Max reuses the same
  // sanity ceiling #893 established for lift weights — the identical real-world
  // quantity (a weight in lbs/kg) reached through a different endpoint.
  @IsNumber()
  @Min(0)
  @Max(MAX_WEIGHT)
  weight!: number;

  @IsString()
  @IsIn(['lbs', 'kg'])
  unit!: 'lbs' | 'kg';
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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrainingMaxEntryDto)
  maxes!: TrainingMaxEntryDto[];
}
