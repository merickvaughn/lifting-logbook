import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { UpdateLiftRecordRequest } from '@lifting-logbook/types';

// See CreateLiftRecordDto for why this implements the shared request contract, and
// for the reasoning behind each field's bounds (closes issue #893 for the PATCH side
// of the same controller — the same Postgres-int32/free-text-length gaps applied here
// too, since this DTO reaches the identical columns via a partial update).
export class UpdateLiftRecordDto implements UpdateLiftRecordRequest {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000)
  weight?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  reps?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
