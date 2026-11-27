import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { COMPLEX_LIMITS, ComplexComponent, CreateBarbellComplexRequest } from '@lifting-logbook/types';
import { trimString } from './create-lift-modification.dto';

/** One component. Whether `lift` names a lift is checked in the controller, against the custom lifts. */
export class ComplexComponentDto implements ComplexComponent {
  @Transform(trimString, { toClassOnly: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lift!: string;

  @IsInt()
  @Min(1)
  @Max(COMPLEX_LIMITS.MAX_REPS)
  reps!: number;
}

export class CreateBarbellComplexDto implements CreateBarbellComplexRequest {
  @Transform(trimString, { toClassOnly: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMPLEX_LIMITS.MAX_NAME_LENGTH)
  name!: string;

  @IsArray()
  @ArrayMinSize(COMPLEX_LIMITS.MIN_COMPONENTS)
  @ArrayMaxSize(COMPLEX_LIMITS.MAX_COMPONENTS)
  @ValidateNested({ each: true })
  @Type(() => ComplexComponentDto)
  components!: ComplexComponentDto[];
}
