import { Module } from '@nestjs/common';
import { BarbellComplexController } from './barbell-complex.controller';
import { CustomLiftController } from './custom-lift.controller';
import { LiftMetadataController } from './lift-metadata.controller';
import { LiftModificationController } from './lift-modification.controller';

@Module({
  controllers: [LiftMetadataController, CustomLiftController, LiftModificationController, BarbellComplexController],
})
export class LiftsModule {}
