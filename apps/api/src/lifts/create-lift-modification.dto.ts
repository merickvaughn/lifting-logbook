import { IsIn, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  CreateLiftModificationRequest,
  LIFT_MODIFICATION_MAX_MODES,
  LiftModificationMaxMode,
} from '@lifting-logbook/types';

/** Bounds shared with UpdateLiftModificationDto, which reaches the same columns. */
export const MAX_MODIFICATION_NAME_LENGTH = 100;
export const MAX_MODIFICATION_DESCRIPTION_LENGTH = 500;

export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// @ValidateIf, not @IsOptional(), on the optional fields: see UpdateCustomLiftDto's comment on why
// an explicit `null` must not pass.
export class CreateLiftModificationDto implements CreateLiftModificationRequest {
  @Transform(trimString, { toClassOnly: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lift!: string;

  @Transform(trimString, { toClassOnly: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MODIFICATION_NAME_LENGTH)
  name!: string;

  @ValidateIf((o: CreateLiftModificationDto) => o.description !== undefined)
  @IsString()
  @MaxLength(MAX_MODIFICATION_DESCRIPTION_LENGTH)
  description?: string;

  @ValidateIf((o: CreateLiftModificationDto) => o.maxMode !== undefined)
  @IsIn(LIFT_MODIFICATION_MAX_MODES)
  maxMode?: LiftModificationMaxMode;
}
