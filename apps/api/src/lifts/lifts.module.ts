import { Module } from '@nestjs/common';
import { CustomLiftController } from './custom-lift.controller';
import { LiftMetadataController } from './lift-metadata.controller';
import { LiftModificationController } from './lift-modification.controller';

@Module({
  controllers: [LiftMetadataController, CustomLiftController, LiftModificationController],
})
export class LiftsModule {}
