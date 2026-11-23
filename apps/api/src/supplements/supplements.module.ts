import { Module } from '@nestjs/common';
import { SupplementSheetMirrorModule } from '../supplement-sheet-mirror/supplement-sheet-mirror.module';
import { SupplementSuggestionsModule } from '../supplement-suggestions/supplement-suggestions.module';
import { SupplementsController } from './supplements.controller';

@Module({
  imports: [SupplementSheetMirrorModule, SupplementSuggestionsModule],
  controllers: [SupplementsController],
})
export class SupplementsModule {}
