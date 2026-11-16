import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { LiftRecordExportQuery } from '@lifting-logbook/types';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The filter of a sets download (#1308). Query values arrive as strings. */
export class LiftRecordExportQueryDto implements LiftRecordExportQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  program?: string;

  /** A macrocycle's stable id. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  macrocycle?: string;

  @IsOptional()
  @Matches(CALENDAR_DATE, { message: 'from must be a calendar date in YYYY-MM-DD format' })
  from?: string;

  @IsOptional()
  @Matches(CALENDAR_DATE, { message: 'to must be a calendar date in YYYY-MM-DD format' })
  to?: string;
}

/** A download names one part, from 1. */
export class LiftRecordExportDownloadQueryDto extends LiftRecordExportQueryDto {
  @IsOptional()
  @Matches(/^[1-9]\d{0,4}$/, { message: 'part must be a whole number from 1' })
  part?: string;

  /** The listing's `split`. When given, a split that has changed since is a 409. */
  @IsOptional()
  @Matches(/^[0-9a-f]{16}$/, { message: 'split must be the value the parts listing returned' })
  split?: string;
}
