import { Module } from '@nestjs/common';
import { SupplementSheetMirrorModule } from '../supplement-sheet-mirror/supplement-sheet-mirror.module';
import { SupplementsController } from './supplements.controller';

@Module({
  imports: [SupplementSheetMirrorModule],
  controllers: [SupplementsController],
})
export class SupplementsModule {}
