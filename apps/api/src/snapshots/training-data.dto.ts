import { Type } from 'class-transformer';
import { IsDefined, IsInt, IsOptional, Matches, Min, ValidateNested } from 'class-validator';
import { ClearTrainingDataRequest, TrainingDataCounts } from '@lifting-logbook/types';

/** The counts the lifter confirmed, one per cleared table (#1309). */
export class TrainingDataCountsDto implements TrainingDataCounts {
  @IsInt() @Min(0) liftRecords!: number;
  @IsInt() @Min(0) macrocycles!: number;
  @IsInt() @Min(0) macrocycleDashboards!: number;
  @IsInt() @Min(0) macrocycleScheduledWorkouts!: number;
  @IsInt() @Min(0) trainingMaxes!: number;
  @IsInt() @Min(0) trainingMaxHistory!: number;
  @IsInt() @Min(0) liftModificationMaxes!: number;
  @IsInt() @Min(0) workoutDateOverrides!: number;
  @IsInt() @Min(0) workoutSkipOverrides!: number;
  @IsInt() @Min(0) workoutLiftOverrides!: number;
  @IsInt() @Min(0) focusDayStates!: number;
  @IsInt() @Min(0) importBatches!: number;
}

/** A snapshot sets download names one part, from 1, and may pass the listing's `split`. */
export class SnapshotLiftRecordsQueryDto {
  @IsOptional()
  @Matches(/^[1-9]\d{0,4}$/, { message: 'part must be a whole number from 1' })
  part?: string;

  @IsOptional()
  @Matches(/^[0-9a-f]{16}$/, { message: 'split must be the value the parts listing returned' })
  split?: string;
}

export class ClearTrainingDataDto implements ClearTrainingDataRequest {
  @IsDefined()
  @ValidateNested()
  @Type(() => TrainingDataCountsDto)
  counts!: TrainingDataCountsDto;
}
