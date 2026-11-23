import { Module } from '@nestjs/common';
import { GoogleSheetModule } from '../google-sheet/google-sheet.module';
import {
  OIDC_VERIFIER,
  SheetMirrorCallerGuard,
  SupplementSheetMirrorController,
  defaultOidcVerifier,
} from './supplement-sheet-mirror.controller';
import { SupplementSheetMirrorService } from './supplement-sheet-mirror.service';
import { CloudTasksSheetMirrorQueue, SHEET_MIRROR_QUEUE } from './sheet-mirror-queue';

@Module({
  imports: [GoogleSheetModule],
  controllers: [SupplementSheetMirrorController],
  providers: [
    SupplementSheetMirrorService,
    SheetMirrorCallerGuard,
    { provide: OIDC_VERIFIER, useFactory: defaultOidcVerifier },
    { provide: SHEET_MIRROR_QUEUE, useValue: new CloudTasksSheetMirrorQueue() },
  ],
  // The second part (#1444) enqueues from the supplement writes and Sync now.
  exports: [SHEET_MIRROR_QUEUE],
})
export class SupplementSheetMirrorModule {}
