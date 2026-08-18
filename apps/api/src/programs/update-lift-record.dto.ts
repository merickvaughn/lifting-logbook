import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { UpdateLiftRecordRequest } from '@lifting-logbook/types';

// See CreateLiftRecordDto for why this implements the shared request contract
// (closes issue #893 for the PATCH side of the same controller).
export class UpdateLiftRecordDto implements UpdateLiftRecordRequest {
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  reps?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
