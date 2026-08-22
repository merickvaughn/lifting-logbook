import {
  validateTrainingMaxImport,
  validateStrengthGoalImport,
  validateProgramSpecImport,
} from "@src/core";
import type {
  StrengthGoalEntry,
  TrainingMax,
  LiftingProgramSpec,
} from "@src/core";

describe("validateTrainingMaxImport", () => {
  const tm = (over: Partial<TrainingMax> = {}): TrainingMax => ({
    dateUpdated: new Date("2026-01-01"),
    lift: "Squat",
    weight: 300,
    ...over,
  });

  it("accepts valid rows and resolves lift names via the slot map", () => {
    const { valid, errors } = validateTrainingMaxImport([tm({ lift: "Bench P." })]);
    expect(errors).toHaveLength(0);
    expect(valid[0]!.lift).toBe("bench-press");
  });

  it("collects errors for a NaN weight and invalid date", () => {
    const { valid, errors } = validateTrainingMaxImport([
      tm({ weight: NaN }),
      tm({ dateUpdated: new Date("nope") }),
    ]);
    expect(valid).toHaveLength(0);
    expect(errors.map((e) => e.field)).toEqual(["weight", "dateUpdated"]);
  });
});

describe("validateStrengthGoalImport", () => {
  const goal = (over: Partial<StrengthGoalEntry> = {}): StrengthGoalEntry => ({
    lift: "Squat",
    goalType: "absolute",
    target: 405,
    unit: "lbs",
    updatedAt: new Date("2026-01-01"),
    ...over,
  });

  it("accepts a valid absolute goal", () => {
    const { valid, errors } = validateStrengthGoalImport([goal()]);
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
  });

  it("requires a ratio for relative goals and a numeric target for absolute", () => {
    const relativeNoRatio: StrengthGoalEntry = {
      lift: "Squat",
      goalType: "relative",
      unit: "lbs",
      updatedAt: new Date("2026-01-01"),
    };
    const absoluteNoTarget: StrengthGoalEntry = {
      lift: "Bench",
      goalType: "absolute",
      unit: "lbs",
      updatedAt: new Date("2026-01-01"),
    };
    const { errors } = validateStrengthGoalImport([relativeNoRatio, absoluteNoTarget]);
    expect(errors.map((e) => e.field)).toEqual(["ratio", "target"]);
  });

  it("rejects an unknown unit", () => {
    const { errors } = validateStrengthGoalImport([
      goal({ unit: "stone" as StrengthGoalEntry["unit"] }),
    ]);
    expect(errors[0]!.field).toBe("unit");
  });
});

describe("validateProgramSpecImport", () => {
  const spec = (over: Partial<LiftingProgramSpec> = {}): LiftingProgramSpec => ({
    week: 1,
    offset: 0,
    lift: "Squat",
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

  it("accepts a valid row", () => {
    const { valid, errors } = validateProgramSpecImport([spec()]);
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
  });

  it("rejects an out-of-range week and a non-numeric sets value", () => {
    const { errors } = validateProgramSpecImport([
      spec({ week: 4 as LiftingProgramSpec["week"] }),
      spec({ sets: NaN }),
    ]);
    const codesByField = errors.map((e) => ({ field: e.field, code: e.code }));
    expect(codesByField).toContainEqual({ field: "week", code: "WEEK_INVALID" });
    expect(codesByField).toContainEqual({ field: "sets", code: "SETS_INVALID" });
  });

  it("rejects an empty lift and an invalid weekType", () => {
    const { errors } = validateProgramSpecImport([
      spec({ lift: "" }),
      spec({ weekType: "bogus" as NonNullable<LiftingProgramSpec["weekType"]> }),
    ]);
    expect(errors).toMatchObject([
      { row: 1, field: "lift", code: "LIFT_EMPTY" },
      { row: 2, field: "weekType", code: "WEEK_TYPE_INVALID" },
    ]);
  });
});
