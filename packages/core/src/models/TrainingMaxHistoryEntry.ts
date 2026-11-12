export interface TrainingMaxHistoryEntry {
  id: string;
  lift: string;
  weight: number;
  reps: number;
  date: Date;
  isPR: boolean;
  source: 'test' | 'program';
  goalMet: boolean;
  /**
   * Set on an entry for a modification's own max (#1153). The history reads leave these out, so a
   * lift's history is the lift's max alone.
   */
  modificationId?: string;
}
