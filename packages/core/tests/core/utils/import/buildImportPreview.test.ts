import {
  buildLiftRecordsPreview,
  buildTrainingMaxPreview,
  buildStrengthGoalPreview,
  buildProgramSpecPreview,
  programSpecNaturalKey,
  trainingMaxRowKind,
  strengthGoalRowKind,
} from "@src/core";
import type {
  LiftRecord,
  TrainingMax,
  StrengthGoalEntry,
  LiftingProgramSpec,
} from "@src/core";

const liftRecord = (over: Partial<LiftRecord> = {}): LiftRecord => ({
  program: "p",
  cycleNum: 1,
  workoutNum: 1,
  date: new Date("2026-01-01"),
  lift: "back-squat",
  setNum: 1,
  weight: 100,
  reps: 5,
  notes: "",
  ...over,
});

describe("buildLiftRecordsPreview", () => {
  it("counts new rows as creates and existing natural keys as skips", () => {
    const existing = [liftRecord({ setNum: 1 })];
    const incoming = [liftRecord({ setNum: 1 }), liftRecord({ setNum: 2 })];
    const preview = buildLiftRecordsPreview(incoming, existing);
    expect(preview).toMatchObject({ creates: 1, updates: 0, skips: 1 });
  });

  it("collapses duplicate keys within the file", () => {
    const incoming = [liftRecord({ setNum: 1 }), liftRecord({ setNum: 1 })];
    const preview = buildLiftRecordsPreview(incoming, []);
    expect(preview.creates).toBe(1);
    expect(preview.skips).toBe(1);
  });

  // Regression for issue #884: two sets sharing every field except date are
  // genuinely different records (e.g. a cycle-numbering reset reusing the
  // same cycle/workout/set combo years apart) and must both be creates, not
  // collapsed into one the way a true same-key duplicate is.
  it("treats rows with the same key but different dates as separate creates", () => {
    const incoming = [
      liftRecord({ setNum: 1, date: new Date("2025-12-16"), weight: 175, reps: 7 }),
      liftRecord({ setNum: 1, date: new Date("2024-01-12"), weight: 202.5, reps: 8 }),
    ];
    const preview = buildLiftRecordsPreview(incoming, []);
    expect(preview).toMatchObject({ creates: 2, skips: 0 });
  });
});

describe("buildTrainingMaxPreview", () => {
  const tm = (lift: string, weight: number): TrainingMax => ({
    dateUpdated: new Date("2026-01-01"),
    lift,
    weight,
  });

  it("classifies create / update / skip by weight change", () => {
    const existing = [tm("squat", 300), tm("bench", 200)];
    const incoming = [tm("squat", 310), tm("bench", 200), tm("deadlift", 400)];
    const preview = buildTrainingMaxPreview(incoming, existing);
    expect(preview).toMatchObject({ creates: 1, updates: 1, skips: 1 });
    const update = preview.deltas.find((d) => d.kind === "update");
    expect(update).toMatchObject({ before: "300", after: "310" });
  });
});

describe("buildStrengthGoalPreview", () => {
  const goal = (lift: string, target: number): StrengthGoalEntry => ({
    lift,
    goalType: "absolute",
    target,
    unit: "lbs",
    updatedAt: new Date("2026-01-01"),
  });

  it("classifies create / update / skip by goal value", () => {
    const existing = [goal("squat", 400)];
    const incoming = [goal("squat", 405), goal("bench", 275)];
    const preview = buildStrengthGoalPreview(incoming, existing);
    expect(preview).toMatchObject({ creates: 1, updates: 1, skips: 0 });
  });
});

describe("buildProgramSpecPreview", () => {
  const spec = (over: Partial<LiftingProgramSpec> = {}): LiftingProgramSpec => ({
    week: 1,
    offset: 0,
    lift: "back-squat",
    increment: 5,
    order: 1,
    sets: 3,
    reps: 5,
    amrap: false,
    warmUpPct: ".5",
    wtDecrementPct: 0.1,
    activation: "",
    ...over,
  });

  it("keys on week:offset:lift:order and detects config changes", () => {
    expect(programSpecNaturalKey(spec())).toBe("1:0:back-squat:1");
    const existing = [spec({ sets: 3 })];
    const incoming = [spec({ sets: 5 }), spec({ order: 2, lift: "bench-press" })];
    const preview = buildProgramSpecPreview(incoming, existing);
    expect(preview).toMatchObject({ creates: 1, updates: 1, skips: 0 });
  });

  it("treats an identical row as a skip", () => {
    const preview = buildProgramSpecPreview([spec()], [spec()]);
    expect(preview).toMatchObject({ creates: 0, updates: 0, skips: 1 });
  });
});

// The shared create/update/skip decision used by BOTH the preview builders above
// and the import-commit repository methods (issue #488), so the two can never
// disagree on a row's classification.
describe("trainingMaxRowKind", () => {
  it("returns create when the lift is absent", () => {
    expect(trainingMaxRowKind({ dateUpdated: new Date(), lift: "squat", weight: 300 }, new Map())).toBe("create");
  });
  it("returns skip when the weight is unchanged and update when it differs", () => {
    const existing = new Map([["squat", 300]]);
    expect(trainingMaxRowKind({ dateUpdated: new Date(), lift: "squat", weight: 300 }, existing)).toBe("skip");
    expect(trainingMaxRowKind({ dateUpdated: new Date(), lift: "squat", weight: 305 }, existing)).toBe("update");
  });
});

describe("strengthGoalRowKind", () => {
  const goal = (target: number): StrengthGoalEntry => ({
    lift: "squat",
    goalType: "absolute",
    target,
    unit: "lbs",
    updatedAt: new Date(),
  });

  it("returns create when the lift is absent", () => {
    expect(strengthGoalRowKind(goal(400), new Map())).toBe("create");
  });
  it("returns skip when the goal value is unchanged and update when it differs", () => {
    const existing = new Map([["squat", goal(400)]]);
    expect(strengthGoalRowKind(goal(400), existing)).toBe("skip");
    expect(strengthGoalRowKind(goal(410), existing)).toBe("update");
  });
});
