import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { COMPLEX_LIMITS, UpdateBarbellComplexRequest } from '@lifting-logbook/types';
import { ComplexComponentDto } from './create-barbell-complex.dto';
import { trimString } from './create-lift-modification.dto';

// @ValidateIf, not @IsOptional(): see UpdateCustomLiftDto's comment on why an explicit `null` must
// not pass.
export class UpdateBarbellComplexDto implements UpdateBarbellComplexRequest {
  @Transform(trimString, { toClassOnly: true })
  @ValidateIf((o: UpdateBarbellComplexDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMPLEX_LIMITS.MAX_NAME_LENGTH)
  name?: string;

  @ValidateIf((o: UpdateBarbellComplexDto) => o.components !== undefined)
  @IsArray()
  @ArrayMinSize(COMPLEX_LIMITS.MIN_COMPONENTS)
  @ArrayMaxSize(COMPLEX_LIMITS.MAX_COMPONENTS)
  @ValidateNested({ each: true })
  @Type(() => ComplexComponentDto)
  components?: ComplexComponentDto[];
}
