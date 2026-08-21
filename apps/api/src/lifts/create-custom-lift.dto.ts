import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { LiftClassification } from '@lifting-logbook/types';
import { MovementProfileDto } from './movement-profile.dto';

const CLASSIFICATIONS: LiftClassification[] = ['compound', 'accessory'];

export class CreateCustomLiftDto {
  // Untrimmed whitespace would defeat the controller's canonicalAliasFor
  // collision guard (" Squat" case-insensitively differs from "squat") and
  // register as live, whitespace-padded key in buildEffectiveSlotMap — a CSV
  // export commonly containing exactly that padding (issue #911 review, third
  // pass). toClassOnly: true per update-training-maxes.dto.ts's established
  // rationale for this exact pattern — scopes the transform to the
  // plainToClass leg only, so a future non-idempotent transform added here
  // won't silently double-apply on the classToPlain round trip.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value), {
    toClassOnly: true,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsIn(CLASSIFICATIONS)
  classification!: LiftClassification;

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
