import { validateTrainingMaxImport } from "@src/core";
import { TrainingMax } from "@src/core/models";

const TEST_SLOT_MAP: Readonly<Record<string, string>> = {
  "Squat": "back-squat",
  "Bench P.": "bench-press",
};

function makeMax(overrides: Partial<TrainingMax> = {}): TrainingMax {
  return {
    dateUpdated: new Date("2026-01-01"),
    lift: "Squat" as TrainingMax["lift"],
    weight: 300,
    ...overrides,
  };
}

describe("validateTrainingMaxImport", () => {
  it("resolves a matched lift name to its canonical id", () => {
    const { valid, errors } = validateTrainingMaxImport([makeMax()], TEST_SLOT_MAP);
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lift).toBe("back-squat");
  });

  it("keeps an unmatched lift name verbatim rather than rejecting it", () => {
    const { valid, errors } = validateTrainingMaxImport(
      [makeMax({ lift: "Some Custom Lift" as TrainingMax["lift"] })],
      TEST_SLOT_MAP,
    );
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lift).toBe("Some Custom Lift");
  });

  it("flags an empty lift", () => {
    const { valid, errors } = validateTrainingMaxImport(
      [makeMax({ lift: "" as TrainingMax["lift"] })],
      TEST_SLOT_MAP,
    );
    expect(valid).toHaveLength(0);
    expect(errors[0]).toMatchObject({ row: 1, field: "lift", code: "LIFT_EMPTY" });
  });

  it("flags a non-numeric weight", () => {
    const { valid, errors } = validateTrainingMaxImport([makeMax({ weight: NaN })], TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors[0]).toMatchObject({ row: 1, field: "weight", code: "WEIGHT_INVALID" });
  });

  // Regression guard (#911 review): membership must be Object.hasOwnProperty,
  // not a bare `slotMap[liftStr] ?? liftStr` lookup — `??` only catches
  // null/undefined, not an inherited Object.prototype member, so a lift name of
  // "toString"/"constructor"/"__proto__" must be kept verbatim (like any other
  // unmatched name) rather than resolving to an inherited function/object.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "keeps lift name '%s' verbatim rather than resolving it via the prototype chain",
    (liftStr) => {
      const { valid, errors } = validateTrainingMaxImport(
        [makeMax({ lift: liftStr as TrainingMax["lift"] })],
        TEST_SLOT_MAP,
      );
      expect(errors).toHaveLength(0);
      expect(valid).toHaveLength(1);
      expect(typeof valid[0]!.lift).toBe("string");
      expect(valid[0]!.lift).toBe(liftStr);
    },
  );
});
