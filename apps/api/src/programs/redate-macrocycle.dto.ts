import { IsDateString, IsOptional } from 'class-validator';
import { RedateMacrocycleRequest } from '@lifting-logbook/types';

export class RedateMacrocycleDto implements RedateMacrocycleRequest {
  /** The lifter's local date (YYYY-MM-DD); re-dated workouts start on or after it. */
  @IsOptional()
  @IsDateString()
  today?: string;
}
