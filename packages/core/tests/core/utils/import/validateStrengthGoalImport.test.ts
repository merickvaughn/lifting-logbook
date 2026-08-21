import { validateStrengthGoalImport } from "@src/core";
import { StrengthGoalEntry } from "@src/core/models";

const TEST_SLOT_MAP: Readonly<Record<string, string>> = {
  "Squat": "back-squat",
};

// Shaped like buildEffectiveSlotMap's output (issue #911/#914): a custom lift is
// keyed by both its display name and its own id, so a raw CSV name exactly
// matching a custom lift's name resolves to that lift's id, and an
// already-resolved id (e.g. from a prior import) passes through unchanged.
const CUSTOM_LIFT_SLOT_MAP: Readonly<Record<string, string>> = {
  ...TEST_SLOT_MAP,
  "Wide-Grip CBL Curls": "custom-lift-abc123",
  "custom-lift-abc123": "custom-lift-abc123",
};

function makeGoal(overrides: Partial<StrengthGoalEntry> = {}): StrengthGoalEntry {
  return {
    lift: "Squat",
    goalType: "absolute",
    target: 315,
    unit: "lbs",
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("validateStrengthGoalImport", () => {
  it("resolves a matched lift name to its canonical id", () => {
    const { valid, errors } = validateStrengthGoalImport([makeGoal()], TEST_SLOT_MAP);
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lift).toBe("back-squat");
  });

  it("keeps an unmatched lift name verbatim rather than rejecting it", () => {
    const { valid, errors } = validateStrengthGoalImport(
      [makeGoal({ lift: "Some Custom Lift" })],
      TEST_SLOT_MAP,
    );
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lift).toBe("Some Custom Lift");
  });

  // Issue #914: a CSV lift name that exactly matches an existing custom lift's
  // display name must resolve to that lift's id, the same way it already does
  // for lift-records via effectiveSlotMapFor — not pass through as raw text.
  it("resolves a CSV lift name matching an existing custom lift to that lift's id", () => {
    const { valid, errors } = validateStrengthGoalImport(
      [makeGoal({ lift: "Wide-Grip CBL Curls" })],
      CUSTOM_LIFT_SLOT_MAP,
    );
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lift).toBe("custom-lift-abc123");
  });

  // The self-mapping half of buildEffectiveSlotMap: a row already pre-resolved
  // to a custom lift's own id must pass through unchanged rather than being
  // treated as an unrecognized name.
  it("passes an already-resolved custom lift id through unchanged", () => {
    const { valid, errors } = validateStrengthGoalImport(
      [makeGoal({ lift: "custom-lift-abc123" })],
      CUSTOM_LIFT_SLOT_MAP,
    );
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lift).toBe("custom-lift-abc123");
  });

  it("flags an empty lift", () => {
    const { valid, errors } = validateStrengthGoalImport([makeGoal({ lift: "" })], TEST_SLOT_MAP);
    expect(valid).toHaveLength(0);
    expect(errors.some((e) => e.field === "lift")).toBe(true);
  });

  it("flags a relative goal missing a numeric ratio", () => {
    // ratio is simply omitted (never set to `undefined` explicitly — this
    // package's strict exactOptionalPropertyTypes rejects that). target's
    // presence from makeGoal's default is irrelevant here: the validator only
    // checks target for 'absolute' goals, ratio for 'relative' ones.
    const { valid, errors } = validateStrengthGoalImport(
      [makeGoal({ goalType: "relative" })],
      TEST_SLOT_MAP,
    );
    expect(valid).toHaveLength(0);
    expect(errors.some((e) => e.field === "ratio")).toBe(true);
  });

  // Regression guard (#911 review): membership must be Object.hasOwnProperty,
  // not a bare `slotMap[liftStr] ?? liftStr` lookup — `??` only catches
  // null/undefined, not an inherited Object.prototype member, so a lift name of
  // "toString"/"constructor"/"__proto__" must be kept verbatim (like any other
  // unmatched name) rather than resolving to an inherited function/object.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "keeps lift name '%s' verbatim rather than resolving it via the prototype chain",
    (liftStr) => {
      const { valid, errors } = validateStrengthGoalImport(
        [makeGoal({ lift: liftStr })],
        TEST_SLOT_MAP,
      );
      expect(errors).toHaveLength(0);
      expect(valid).toHaveLength(1);
      expect(typeof valid[0]!.lift).toBe("string");
      expect(valid[0]!.lift).toBe(liftStr);
    },
  );
});
