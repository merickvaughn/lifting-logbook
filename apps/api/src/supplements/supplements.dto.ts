import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
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
  @IsOptional() @IsString() @MaxLength(NAME) keyCompound?: string;
  @IsOptional() @IsString() @MaxLength(NAME) timing?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) shortNote?: string;
  @IsOptional() @IsString() @MaxLength(TEXT) longNote?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) @MaxLength(TEXT, { each: true }) links?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => IngredientDto)
  ingredients?: IngredientDto[];
}

export class CreateSupplementItemDto extends ItemDetailsDto {
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @IsOptional() @IsIn(STATUSES) status?: SupplementStatus;
  @IsOptional() @IsBoolean() unverified?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DoseDto) doses?: DoseDto[];
}

export class UpdateSupplementItemDto extends ItemDetailsDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(NAME) name?: string;
  @IsOptional() @IsIn(STATUSES) status?: SupplementStatus;
  /** Only `false`: confirming an item against its label can't be undone. */
  @IsOptional() @IsIn([false]) unverified?: false;
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DoseDto) doses?: DoseDto[];
}

export class DayTypeDto {
  @IsString() @MinLength(1) @MaxLength(NAME) id!: string;
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @IsOptional() @Matches(CLOCK_TIME, { message: 'sessionTime must be 24-hour HH:MM' }) sessionTime?: string;
}

export class SupplementSettingsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DayTypeDto)
  dayTypes?: DayTypeDto[];
  @IsOptional() @Matches(CLOCK_TIME, { message: 'caffeineCutoff must be 24-hour HH:MM' }) caffeineCutoff?: string;
}

export class MoveDosesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
  @IsIn(SUPPLEMENT_SLOTS) from!: SupplementSlot;
  @IsIn(SUPPLEMENT_SLOTS) to!: SupplementSlot;
  /** Replaces the moved doses' day types when given. */
  @IsOptional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) dayTypes?: string[];
}

export class SetStatusDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
  @IsIn(STATUSES) status!: SupplementStatus;
}

export class CreateMixDto {
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
}
