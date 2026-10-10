import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class MacrocyclePlanRequestDto {
  @IsString()
  @MinLength(1)
  program!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  goal!: string;

  @IsInt()
  @Min(1)
  macrocycleNum!: number;
}
