import { IsNumber, IsPositive, Max } from 'class-validator';
import { PutModificationMaxRequest } from '@lifting-logbook/types';
import { MAX_WEIGHT } from './lift-record.limits';

/** A modification's own max takes the bounds a lift's does (`TrainingMaxEntryDto.weight`). */
export class PutModificationMaxDto implements PutModificationMaxRequest {
  @IsNumber()
  @IsPositive()
  @Max(MAX_WEIGHT)
  weight!: number;
}
