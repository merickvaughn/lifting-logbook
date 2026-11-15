import { IsDateString, Matches } from 'class-validator';
import { RedateMacrocycleRequest } from '@lifting-logbook/types';
import { BARE_DATE_MESSAGE, BARE_DATE_PATTERN, BARE_DATE_STRING_OPTIONS } from './lift-record.limits';

export class RedateMacrocycleDto implements RedateMacrocycleRequest {
  /**
   * The lifter's local date; re-dated workouts start on or after it. A bare calendar date only:
   * a datetime with an offset, or a rolled-over day, would move the start by a day.
   */
  @Matches(BARE_DATE_PATTERN, { message: BARE_DATE_MESSAGE })
  @IsDateString(BARE_DATE_STRING_OPTIONS)
  today!: string;
}
