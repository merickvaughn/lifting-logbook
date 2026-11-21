import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { INGREDIENT_UNITS, SUPPLEMENT_SLOTS } from '@lifting-logbook/types';
import type { IngredientUnit, SupplementSlot, SupplementStatus } from '@lifting-logbook/types';

/** 24-hour `HH:MM`. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SupplementStatus[] = ['active', 'pending'];
const TEXT = 2000;
const NAME = 200;
const LIST = 100;

/**
 * Optional, but not nullable: `@IsOptional()` would also let an explicit `null` through, which
 * the controller would store or fail on (#1374 review, B4). Absent skips the field's checks;
 * `null` fails them.
 */
const Optional = () => ValidateIf((_object: object, value: unknown) => value !== undefined);

export class IngredientDto {
  @IsString() @MinLength(1) @MaxLength(NAME) key!: string;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) amount!: number;
  @IsIn(INGREDIENT_UNITS) unit!: IngredientUnit;
}

export class DoseDto {
  @IsIn(SUPPLEMENT_SLOTS) slot!: SupplementSlot;
  @IsString() @MaxLength(NAME) amount!: string;
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) servings!: number;
  @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) dayTypes!: string[];
}

/** The fields an `edited` change sets, besides the name. */
class ItemDetailsDto {
  @Optional() @IsString() @MaxLength(NAME) keyCompound?: string;
  @Optional() @IsString() @MaxLength(NAME) timing?: string;
  @Optional() @IsString() @MaxLength(TEXT) shortNote?: string;
  @Optional() @IsString() @MaxLength(TEXT) longNote?: string;
  @Optional() @IsArray() @ArrayMaxSize(LIST) @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { each: true })
  @MaxLength(TEXT, { each: true })
  links?: string[];
  @Optional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => IngredientDto)
  ingredients?: IngredientDto[];
}

export class CreateSupplementItemDto extends ItemDetailsDto {
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @Optional() @IsIn(STATUSES) status?: SupplementStatus;
  @Optional() @IsBoolean() unverified?: boolean;
  @Optional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DoseDto) doses?: DoseDto[];
}

export class UpdateSupplementItemDto extends ItemDetailsDto {
  @Optional() @IsString() @MinLength(1) @MaxLength(NAME) name?: string;
  @Optional() @IsIn(STATUSES) status?: SupplementStatus;
  /** Only `false`: confirming an item against its label can't be undone. */
  @Optional() @IsIn([false]) unverified?: false;
  @Optional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DoseDto) doses?: DoseDto[];
}

export class DayTypeDto {
  @IsString() @MinLength(1) @MaxLength(NAME) id!: string;
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @Optional() @Matches(CLOCK_TIME, { message: 'sessionTime must be 24-hour HH:MM' }) sessionTime?: string;
}

export class SupplementSettingsDto {
  @Optional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DayTypeDto)
  dayTypes?: DayTypeDto[];
  @Optional() @Matches(CLOCK_TIME, { message: 'caffeineCutoff must be 24-hour HH:MM' }) caffeineCutoff?: string;
}

export class MoveDosesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
  @IsIn(SUPPLEMENT_SLOTS) from!: SupplementSlot;
  @IsIn(SUPPLEMENT_SLOTS) to!: SupplementSlot;
  /** Replaces the moved doses' day types when given. */
  @Optional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) dayTypes?: string[];
}

export class SetStatusDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
  @IsIn(STATUSES) status!: SupplementStatus;
}

export class CreateMixDto {
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
}
