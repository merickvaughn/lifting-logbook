import { LiftName } from '@lifting-logbook/types';

// LiftRecord interface for individual workout log entries
export interface LiftRecord {
  program: string;
  cycleNum: number;
  workoutNum: number;
  date: Date;
  lift: LiftName;
  setNum: number;
  weight: number;
  reps: number;
  notes: string;
}
