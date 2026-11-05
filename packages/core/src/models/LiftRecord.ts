import { LiftName } from '@lifting-logbook/types';

// LiftRecord interface for individual workout log entries
export interface LiftRecord {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  date: Date;
  lift: LiftName;
  /**
   * Which occurrence of `lift` in its workout the set belongs to, from 0; absent
   * means 0. A program can plan one lift twice in a day, and each occurrence logs
   * its own sets (#1027). See `liftOccurrences`.
   */
  occurrence?: number;
  setNum: number;
  weight: number;
  reps: number;
  notes: string;
  /**
   * The ids of the lift modifications on for this set; absent means none. Not part of the
   * natural key or public id: it is still set N of this lift (ADR-041).
   */
  modifications?: string[];
}
