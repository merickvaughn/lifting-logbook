import { Module } from '@nestjs/common';
import { GoogleSheetModule } from '../google-sheet/google-sheet.module';
import {
  OIDC_VERIFIER,
  SheetMirrorCallerGuard,
  SupplementSheetMirrorController,
  defaultOidcVerifier,
} from './supplement-sheet-mirror.controller';
import { SupplementSheetMirrorService } from './supplement-sheet-mirror.service';
import { SupplementSheetMirrorTrigger } from './supplement-sheet-mirror.trigger';
import { SheetSyncController } from './sheet-sync.controller';
import { CloudTasksSheetMirrorQueue, SHEET_MIRROR_QUEUE } from './sheet-mirror-queue';

@Module({
  imports: [GoogleSheetModule],
  controllers: [SupplementSheetMirrorController, SheetSyncController],
  providers: [
    SupplementSheetMirrorService,
    SupplementSheetMirrorTrigger,
    SheetMirrorCallerGuard,
    { provide: OIDC_VERIFIER, useFactory: defaultOidcVerifier },
    { provide: SHEET_MIRROR_QUEUE, useValue: new CloudTasksSheetMirrorQueue() },
  ],
  // The supplement writes enqueue through the trigger (#1444).
  exports: [SHEET_MIRROR_QUEUE, SupplementSheetMirrorTrigger],
})
export class SupplementSheetMirrorModule {}
