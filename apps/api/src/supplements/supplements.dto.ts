import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { INGREDIENT_UNITS, SUPPLEMENT_SLOTS, SUPPLEMENT_TEXT_MAX } from '@lifting-logbook/types';
import type { IngredientUnit, SupplementSlot, SupplementStatus } from '@lifting-logbook/types';

/** 24-hour `HH:MM`. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SupplementStatus[] = ['active', 'pending'];
const TEXT = SUPPLEMENT_TEXT_MAX.text;
const NAME = SUPPLEMENT_TEXT_MAX.name;
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

export class LinkDto {
  @IsString() @MaxLength(SUPPLEMENT_TEXT_MAX.linkLabel) label!: string;
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(TEXT) url!: string;
}

/** The fields an `edited` change sets, besides the name. */
class ItemDetailsDto {
  @Optional() @IsString() @MaxLength(NAME) keyCompound?: string;
  @Optional() @IsString() @MaxLength(NAME) timing?: string;
  @Optional() @IsString() @MaxLength(TEXT) shortNote?: string;
  @Optional() @IsString() @MaxLength(TEXT) longNote?: string;
  @Optional() @IsString() @MaxLength(NAME) category?: string;
  @Optional() @IsString() @MaxLength(NAME) typicalRange?: string;
  @Optional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => LinkDto)
  links?: LinkDto[];
  @Optional() @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => IngredientDto)
  ingredients?: IngredientDto[];
}

export class CreateSupplementItemDto extends ItemDetailsDto {
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  /** The catalog entry to copy reference content and blank fields from. Not settable on a PATCH. */
  @Optional() @IsString() @MaxLength(NAME) catalogKey?: string;
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

/** One dose, by its position in the item's doses and the slot the client saw it in. */
export class DoseRefDto {
  @IsString() itemId!: string;
  @IsNumber({ maxDecimalPlaces: 0 }) @Min(0) index!: number;
  @IsIn(SUPPLEMENT_SLOTS) slot!: SupplementSlot;
}

export class MoveDosesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
  /** Moves every dose of the items in this slot. Required unless `doses` names the doses. */
  @ValidateIf((o: MoveDosesDto) => o.doses === undefined) @IsIn(SUPPLEMENT_SLOTS) from?: SupplementSlot;
  /**
   * The exact doses to move, in any slots, in one write (#1410): an item can have two doses in one
   * slot on different day types, and `from` would move both. Each must name one of `itemIds`.
   */
  @Optional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DoseRefDto)
  doses?: DoseRefDto[];
  @IsIn(SUPPLEMENT_SLOTS) to!: SupplementSlot;
  /** Replaces the moved doses' day types when given. */
  @Optional() @IsArray() @ArrayMaxSize(LIST) @IsString({ each: true }) dayTypes?: string[];
}

export class SetStatusDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
  @IsIn(STATUSES) status!: SupplementStatus;
}

export class RemoveItemsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
}

export class CreateMixDto {
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(LIST) @IsString({ each: true }) itemIds!: string[];
}

export class SupplementSheetDto {
  /** A Google Sheets link or bare spreadsheet ID; shape is checked by `parseGoogleSheetUrl`. */
  @IsString() @MaxLength(2048) url!: string;
}

export class ImportRowDto {
  @IsString() @MinLength(1) @MaxLength(NAME) name!: string;
  @Optional() @IsString() @MaxLength(NAME) catalogKey?: string;
  @IsString() @MaxLength(NAME) amount!: string;
  @IsString() @MaxLength(NAME) timing!: string;
  @IsString() @MaxLength(TEXT) shortNote!: string;
  @IsString() @MaxLength(TEXT) longNote!: string;
  @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => LinkDto) links!: LinkDto[];
  @IsArray() @ArrayMaxSize(LIST) @ValidateNested({ each: true }) @Type(() => DoseDto) doses!: DoseDto[];
  @IsIn(STATUSES) status!: SupplementStatus;
}

export class ImportSupplementsDto {
  @IsString() @MinLength(1) @MaxLength(NAME) source!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ImportRowDto) rows!: ImportRowDto[];
  /** Sheet rows the lifter skipped; logged, never stored. */
  @Optional() @IsInt() @Min(0) @Max(500) skipped?: number;
}
