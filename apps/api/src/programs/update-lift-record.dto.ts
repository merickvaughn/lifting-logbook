import { IsInt, IsNumber, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { UpdateLiftRecordRequest } from '@lifting-logbook/types';
import { MAX_NOTES_LENGTH, MAX_REPS, MAX_WEIGHT } from './lift-record.limits';

// `implements` is only weakly protective here: every member of
// UpdateLiftRecordRequest is already optional, so an *empty* class would also satisfy
// it — it catches a member being retyped, not one being added. Kept for the retyping
// guarantee; there is no compile-time signal if the interface ever grows a new field.
export class UpdateLiftRecordDto implements UpdateLiftRecordRequest {
  // `@ValidateIf` here, not `@IsOptional()`: `@IsOptional()` skips validation when a
  // value is `null` *or* `undefined`, but only `undefined` (the key genuinely absent)
  // is a legitimate "leave this field unchanged" signal for a PATCH — these columns
  // are non-nullable (weight Float / reps Int / notes String @default("")). Verified
  // that `@IsOptional()` let `{ weight: null }` through with zero validation errors,
  // and the Prisma repository's `updates.weight !== undefined && { weight: ... }`
  // spread (apps/api/src/adapters/prisma/lift-record.repository.ts) then forwards the
  // literal `null` into the update, which Prisma rejects as a
  // PrismaClientValidationError — not a PrismaClientKnownRequestError, so it isn't
  // caught by the existing P2025 handler and escapes as an unhandled 500. The
  // in-memory adapter's `updates.weight ?? current.weight` silently coerces `null`
  // away instead, so its e2e suite can't reproduce this — only the DB-backed suite
  // can (issue #893 review round 3).
  @ValidateIf((o: UpdateLiftRecordDto) => o.weight !== undefined)
  @IsNumber()
  @Min(0)
  @Max(MAX_WEIGHT)
  weight?: number;

  @ValidateIf((o: UpdateLiftRecordDto) => o.reps !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_REPS)
  reps?: number;

  @ValidateIf((o: UpdateLiftRecordDto) => o.notes !== undefined)
  @IsString()
  @MaxLength(MAX_NOTES_LENGTH)
  notes?: string;
}
