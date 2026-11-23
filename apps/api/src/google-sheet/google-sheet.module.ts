import { Module } from '@nestjs/common';
import { FetchGoogleSheetClient } from './google-sheet.client';
import { GoogleSheetController } from './google-sheet.controller';
import { GOOGLE_SHEET_CLIENT, GOOGLE_TOKEN_CIPHER, GoogleSheetService } from './google-sheet.service';
import { CloudKmsKeyWrapper, TokenCipher } from './token-cipher';

@Module({
  controllers: [GoogleSheetController],
  providers: [
    GoogleSheetService,
    { provide: GOOGLE_SHEET_CLIENT, useValue: new FetchGoogleSheetClient() },
    // The key is only called once a lifter links, so an unset name fails that request, not boot.
    {
      provide: GOOGLE_TOKEN_CIPHER,
      useFactory: () => new TokenCipher(new CloudKmsKeyWrapper(process.env.GOOGLE_OAUTH_TOKEN_KMS_KEY_NAME ?? '')),
    },
  ],
})
export class GoogleSheetModule {}
