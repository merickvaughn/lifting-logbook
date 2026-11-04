import { IsString, MaxLength } from 'class-validator';
import { GoogleSheetImportRequest } from '@lifting-logbook/types';

// `implements GoogleSheetImportRequest` ties this validated DTO to the shared
// request contract in @lifting-logbook/types.
export class GoogleSheetImportDto implements GoogleSheetImportRequest {
  /** A Google Sheets link or bare spreadsheet ID; shape is checked by `parseGoogleSheetUrl`. */
  @IsString()
  @MaxLength(2048)
  url!: string;
}
