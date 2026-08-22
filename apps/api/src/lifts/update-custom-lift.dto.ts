import { IsBoolean, IsIn, IsObject, IsString, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { LiftClassification } from '@lifting-logbook/types';
import { MovementProfileDto } from './movement-profile.dto';

const CLASSIFICATIONS: LiftClassification[] = ['compound', 'accessory'];

// @ValidateIf, not @IsOptional(), on every field below: @IsOptional() skips
// validation when a value is null OR undefined, but only undefined (the key
// genuinely absent) is a legitimate "leave this field unchanged" signal for a
// PATCH — every column here is non-nullable. This is the identical gap
// update-lift-record.dto.ts already documents fixing the same way for issue
// #893's review — {"name": null} passed @IsOptional() with zero validation
// errors, reached this method's own guard as dto.name === null, and (once
// that guard's own crash was separately fixed) still forwarded null into the
// repository patch: the in-memory adapter silently stores it, but the
// Prisma-backed production adapter's non-nullable `name String` column
// rejects it as a PrismaClientValidationError — not a
// PrismaClientKnownRequestError, so no registered filter catches it, and it
// escapes as an unhandled 500 (issue #911 review, sixth pass).
export class UpdateCustomLiftDto {
  // See create-custom-lift.dto.ts's name field for why this transform exists
  // and why toClassOnly: true.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value), {
    toClassOnly: true,
  })
  @ValidateIf((o: UpdateCustomLiftDto) => o.name !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ValidateIf((o: UpdateCustomLiftDto) => o.classification !== undefined)
  @IsString()
  @IsIn(CLASSIFICATIONS)
  classification?: LiftClassification;

  // Reject primitives that would otherwise bypass @ValidateNested (a silent no-op
  // on non-objects), matching the nested-DTO pattern used elsewhere in the API.
  @ValidateIf((o: UpdateCustomLiftDto) => o.movementProfile !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => MovementProfileDto)
  movementProfile?: MovementProfileDto;

  @ValidateIf((o: UpdateCustomLiftDto) => o.isBodyweightComponent !== undefined)
  @IsBoolean()
  isBodyweightComponent?: boolean;
}
