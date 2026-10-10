import { IsDateString, IsOptional } from 'class-validator';

export class InitializeMacrocycleDto {
  @IsOptional()
  @IsDateString()
  macrocycleDate?: string;
}
