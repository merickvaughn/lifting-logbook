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
    // The key is only called once a lifter links. With no name set the service answers 503
    // google-sheet-unconfigured, so the wrapper is never called with an empty one.
    {
      provide: GOOGLE_TOKEN_CIPHER,
      useFactory: () => new TokenCipher(new CloudKmsKeyWrapper(process.env.GOOGLE_OAUTH_TOKEN_KMS_KEY_NAME ?? '')),
    },
  ],
  // The supplement sheet mirror (#1443) refreshes tokens and writes sheets with the same two.
  exports: [GOOGLE_SHEET_CLIENT, GOOGLE_TOKEN_CIPHER],
})
export class GoogleSheetModule {}
