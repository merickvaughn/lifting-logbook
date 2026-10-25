import { Module } from '@nestjs/common';
import { FocusController, FocusWorkoutController } from './focus.controller';

@Module({
  controllers: [FocusController, FocusWorkoutController],
})
export class FocusModule {}
