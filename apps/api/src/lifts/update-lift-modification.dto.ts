import { IsIn, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  LIFT_MODIFICATION_MAX_MODES,
  LiftModificationMaxMode,
  UpdateLiftModificationRequest,
} from '@lifting-logbook/types';
import {
  MAX_MODIFICATION_DESCRIPTION_LENGTH,
  MAX_MODIFICATION_NAME_LENGTH,
  trimString,
} from './create-lift-modification.dto';

// @ValidateIf, not @IsOptional(): see UpdateCustomLiftDto's comment on why an explicit `null` must
// not pass.
export class UpdateLiftModificationDto implements UpdateLiftModificationRequest {
  @Transform(trimString, { toClassOnly: true })
  @ValidateIf((o: UpdateLiftModificationDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MODIFICATION_NAME_LENGTH)
  name?: string;

  @ValidateIf((o: UpdateLiftModificationDto) => o.description !== undefined)
  @IsString()
  @MaxLength(MAX_MODIFICATION_DESCRIPTION_LENGTH)
  description?: string;

  @ValidateIf((o: UpdateLiftModificationDto) => o.maxMode !== undefined)
  @IsIn(LIFT_MODIFICATION_MAX_MODES)
  maxMode?: LiftModificationMaxMode;
}
