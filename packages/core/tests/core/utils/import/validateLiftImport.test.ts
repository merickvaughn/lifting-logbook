import { validateLiftImport } from "@src/core";
import { LiftRecord } from "@src/core/models";

/** Minimal slot map covering the fixture abbreviations we test against. */
const TEST_SLOT_MAP: Readonly<Record<string, string>> = {
  "Squat": "back-squat",
  "Bench P.": "bench-press",
  "Deadlift": "deadlift",
};

function makeRecord(overrides: Partial<LiftRecord> = {}): LiftRecord {
  return {
    program: "RPT",
    cycleNum: 1,
    workoutNum: 1,
    date: new Date("2025-01-01"),
    lift: "Squat" as LiftRecord["lift"],
    setNum: 1,
    weight: 200,
    reps: 5,
    notes: "",
    ...overrides,
  };
}

describe("validateLiftImport", () => {
  it("passes all valid rows and resolves lift abbreviations", () => {
    const records = [
      makeRecord({ lift: "Squat" as LiftRecord["lift"] }),
      makeRecord({ lift: "Bench P." as LiftRecord["lift"], setNum: 2 }),
    ];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(2);
    expect(valid[0]!.lift).toBe("back-squat");
    expect(valid[1]!.lift).toBe("bench-press");
  });

  it("flags an unknown lift abbreviation", () => {
    const records = [makeRecord({ lift: "Cable Curls" as LiftRecord["lift"] })];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 1, field: "lift" });
    expect(errors[0]!.message).toMatch(/Cable Curls/);
    // Regression guard (#911): the message must never leak internal jargon —
    // it's rendered verbatim by a caller with no interactive remap UI of its own.
    expect(errors[0]!.message).not.toMatch(/slot map/i);
  });

  // Regression guard (#911 review, second pass): a blank/missing lift value
  // must never render the interpolated 'undefined' isn't a recognized
  // exercise... message — the "unrecognized name" message is for a genuinely
  // typed-but-unknown name, not a missing Lift column, which would otherwise
  // produce that confusing message on every single row.
  it("flags an empty lift with a distinct 'no exercise name' message, not the interpolated unrecognized-name one", () => {
    const records = [makeRecord({ lift: "" as LiftRecord["lift"] })];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 1, field: "lift" });
    expect(errors[0]!.message).not.toMatch(/undefined/);
    expect(errors[0]!.message).not.toMatch(/isn't a recognized exercise/);
    expect(errors[0]!.message).toMatch(/no exercise name/i);
  });

  it("flags a NaN weight", () => {
    const records = [makeRecord({ weight: NaN })];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 1, field: "weight" });
  });

  it("flags a NaN reps", () => {
    const records = [makeRecord({ reps: NaN })];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(errors.some((e) => e.field === "reps")).toBe(true);
  });

  it("flags an invalid date", () => {
    const records = [makeRecord({ date: new Date("not-a-date") })];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 1, field: "date" });
  });

  it("collects all errors across multiple bad rows", () => {
    const records = [
      makeRecord({ weight: NaN }),               // row 1: bad weight
      makeRecord({ lift: "Unknown" as LiftRecord["lift"], setNum: 2 }), // row 2: bad lift
    ];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.row)).toEqual([1, 2]);
  });

  it("returns valid rows alongside errors (partial pass)", () => {
    const records = [
      makeRecord({ lift: "Squat" as LiftRecord["lift"] }),             // row 1: valid
      makeRecord({ weight: NaN, setNum: 2 }),                          // row 2: invalid
    ];
    const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lift).toBe("back-squat");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.row).toBe(2);
  });

  it("returns empty results for an empty input", () => {
    const { valid, errors } = validateLiftImport([], TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  // Regression guard (#911 review): membership must be Object.hasOwn, not the `in`
  // operator, which walks the prototype chain — a lift string of "toString",
  // "constructor", or "__proto__" must fail like any other unrecognized name, not
  // silently resolve to an inherited Object.prototype member.
  describe("prototype-chain safety", () => {
    it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
      "flags '%s' as an unrecognized lift rather than resolving it via the prototype chain",
      (liftStr) => {
        const records = [makeRecord({ lift: liftStr as LiftRecord["lift"] })];
        const { valid, errors } = validateLiftImport(records, TEST_SLOT_MAP);
        expect(valid).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ row: 1, field: "lift" });
      },
    );
  });
});
