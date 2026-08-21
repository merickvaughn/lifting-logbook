import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { LiftClassification } from '@lifting-logbook/types';
import { MovementProfileDto } from './movement-profile.dto';

const CLASSIFICATIONS: LiftClassification[] = ['compound', 'accessory'];

export class UpdateCustomLiftDto {
  // See create-custom-lift.dto.ts's name field for why this transform exists
  // and why toClassOnly: true (issue #911 review, third pass).
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value), {
    toClassOnly: true,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @IsString()
  @IsIn(CLASSIFICATIONS)
  @IsOptional()
  classification?: LiftClassification;

  // Reject primitives that would otherwise bypass @ValidateNested (a silent no-op
  // on non-objects), matching the nested-DTO pattern used elsewhere in the API.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MovementProfileDto)
  movementProfile?: MovementProfileDto;

  @IsBoolean()
  @IsOptional()
  isBodyweightComponent?: boolean;
}
