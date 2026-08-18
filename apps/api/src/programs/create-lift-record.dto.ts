import { IsDateString, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { CreateLiftRecordRequest } from '@lifting-logbook/types';

// Implements the shared request contract in @lifting-logbook/types for every field
// except `program` (see below) — for the rest, if the contract's shape changes, this
// class fails to compile until the validation is updated to match. Before this class
// existed, the controller declared `@Body() body: CreateLiftRecordRequest` directly —
// a plain interface is erased at compile time, so Nest's ValidationPipe had no
// metatype to validate against and silently let any JSON object through unchecked
// (issue #893).
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

  @IsInt()
  @Min(1)
  cycleNum!: number;

  @IsInt()
  @Min(1)
  workoutNum!: number;

  /**
   * ISO 8601 date string. When omitted the server uses the scheduled date for this
   * workout, falling back to today. `@IsDateString()` accepts both a bare `YYYY-MM-DD`
   * and a full date-time — the controller normalizes whatever comes through via
   * `toUTCMidnight` regardless, so this only needs to reject non-date garbage that
   * would otherwise reach `new Date(...)` and produce an `Invalid Date`.
   */
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsString()
  lift!: string;

  @IsInt()
  @Min(1)
  setNum!: number;

  // Float, not Int (matches the `weight Float` column) — fractional plate loads
  // (e.g. 182.5 lbs) are valid. 0 is allowed for bodyweight-only exercises.
  @IsNumber()
  @Min(0)
  weight!: number;

  @IsInt()
  @Min(1)
  reps!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
