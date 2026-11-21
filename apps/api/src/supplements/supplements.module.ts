import { Module } from '@nestjs/common';
import { SupplementsController } from './supplements.controller';

@Module({
  controllers: [SupplementsController],
})
export class SupplementsModule {}
