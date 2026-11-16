import { Module } from '@nestjs/common';
import { SnapshotsController } from './snapshots.controller';

/** Clear data and its snapshots (#1309). */
@Module({
  controllers: [SnapshotsController],
})
export class SnapshotsModule {}
