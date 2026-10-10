import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';

export class StartNewMacrocycleDto {
  /** Use records from this macrocycle number instead of the current macrocycle. */
  @IsOptional()
  @IsInt()
  @Min(1)
  fromMacrocycleNum?: number;

  /** ISO date string (YYYY-MM-DD) to pin the new macrocycle's start date explicitly. */
  @IsOptional()
  @IsDateString()
  macrocycleDate?: string;
}
