// LiftRecord header mapping for parsing
export const LIFT_RECORD_HEADER_MAP: Record<
  string,
  { key: string; type: string }
> = {
  Program: { key: "program", type: "string" },
  "Macrocycle #": { key: "macrocycleNum", type: "number" },
  "Workout #": { key: "workoutNum", type: "number" },
  Date: { key: "date", type: "string" },
  Lift: { key: "lift", type: "string" },
  "Set #": { key: "setNum", type: "number" },
  Weight: { key: "weight", type: "number" },
  Reps: { key: "reps", type: "number" },
  Notes: { key: "notes", type: "string" },
};
// Other header spellings accepted for a canonical lift-record column, keyed by the
// canonical header. Not dead compatibility code: the Google Sheet this app imports
// from still emits "Cycle #" (the column predates the macrocycle rename, #1038), so
// it is the usual header in an import, not an edge case. Read by parseLiftRecords
// and fuzzyColumnMapper; classifyImport's 'cycle' token matches both by substring.
export const LEGACY_LIFT_RECORD_HEADERS: Readonly<Record<string, readonly string[]>> = {
  "Macrocycle #": ["Cycle #"],
};
// TrainingMax header mapping for parsing
export const TRAINING_MAX_HEADER_MAP: Record<
  string,
  { key: string; type: string }
> = {
  "Date Updated": { key: "dateUpdated", type: "string" },
  Lift: { key: "lift", type: "string" },
  Weight: { key: "weight", type: "number" },
};
// LiftingProgramSpec header mapping for parsing
export const LIFTING_PROGRAM_SPEC_HEADER_MAP: Record<
  string,
  { key: string; type: string }
> = {
  Week: { key: "week", type: "number" },
  Offset: { key: "offset", type: "number" },
  Lift: { key: "lift", type: "string" },
  Increment: { key: "increment", type: "number" },
  Order: { key: "order", type: "number" },
  Sets: { key: "sets", type: "number" },
  Reps: { key: "reps", type: "number" },
  "AMRAP?": { key: "amrap", type: "boolean|string" },
  "Warm-Up %": { key: "warmUpPct", type: "string" },
  "WT Decrement %": { key: "wtDecrementPct", type: "number" },
  Activation: { key: "activation", type: "string" },
  "Week Type": { key: "weekType", type: "string" },
};

export const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
