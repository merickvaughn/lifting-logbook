/**
 * The training max of a lift modification whose `maxMode` is `own` (#1153). It plans the sets that
 * modification is on, and moves with them, without touching the lift's max. Scoped to a program,
 * like a lift's training max.
 */
export interface ModificationMax {
  modificationId: string;
  weight: number;
  dateUpdated: Date;
}
