import type { LiftOverride } from "@src/core/models/LiftOverride";
import {
  plannedLiftRows,
  resolveDayPrescriptions,
} from "@src/core/services/workout/dayPrescriptions";

// A day's rows; each names its lift and a rep target that tells the rows apart.
const squat = { lift: "Squat", reps: 5 };
const bench = { lift: "Bench Press", reps: 8 };
const deadlift = { lift: "Deadlift", reps: 3 };
const dayRows = [squat, bench, deadlift];

const replace = (lift: string, replacedBy: string): LiftOverride => ({
  lift,
  action: "replace",
  replacedBy,
});

describe("plannedLiftRows — the page rule", () => {
  it("gives a lift in its own slot its own row", () => {
    expect(plannedLiftRows(dayRows, [{ lift: "Bench Press" }, { lift: "Squat" }])).toEqual([
      bench,
      squat,
    ]);
  });

  it("gives a replacement the row of the slot it replaces (#1014)", () => {
    expect(plannedLiftRows(dayRows, [{ lift: "Dips", replaces: "Bench Press" }])).toEqual([bench]);
  });

  it("gives a lift the day doesn't prescribe no row, keeping index alignment", () => {
    expect(
      plannedLiftRows(dayRows, [{ lift: "Curl" }, { lift: "Squat" }, { lift: "Row", replaces: "Curl" }]),
    ).toEqual([undefined, squat, undefined]);
  });

  it("takes the day's first row for a lift the day repeats (#1027)", () => {
    const second = { lift: "Squat", reps: 1 };
    expect(plannedLiftRows([squat, second], [{ lift: "Squat" }])).toEqual([squat]);
  });
});

describe("resolveDayPrescriptions", () => {
  it("lists each spec lift once, in the day's order, with no overrides", () => {
    const { planned, rowByStoredLift } = resolveDayPrescriptions([squat, bench, { lift: "Squat", reps: 1 }], []);
    expect(planned).toEqual([{ lift: "Squat" }, { lift: "Bench Press" }]);
    expect(rowByStoredLift).toEqual(new Map([["Squat", squat], ["Bench Press", bench]]));
  });

  it("returns the overrides as applyLiftOverrides applies them", () => {
    const { planned, renamed, removed } = resolveDayPrescriptions(dayRows, [
      replace("Squat", "Front Squat"),
      { lift: "Deadlift", action: "remove" },
      { lift: "Curl", action: "add" },
    ]);
    expect(planned).toEqual([
      { lift: "Front Squat", replaces: "Squat" },
      { lift: "Bench Press" },
      { lift: "Curl" },
    ]);
    expect(renamed).toEqual(new Map([["Squat", "Front Squat"]]));
    expect(removed).toEqual(new Set(["Deadlift"]));
  });

  it("gives a replacement its slot's row, through a chain of swaps", () => {
    const { rowByStoredLift } = resolveDayPrescriptions(dayRows, [
      replace("Squat", "Front Squat"),
      replace("Front Squat", "Box Squat"),
    ]);
    expect(rowByStoredLift.get("Box Squat")).toBe(squat);
  });

  it("gives sets under a slot's earlier names the slot's row", () => {
    const { rowByStoredLift } = resolveDayPrescriptions(dayRows, [
      replace("Squat", "Front Squat"),
      replace("Front Squat", "Box Squat"),
    ]);
    expect(rowByStoredLift.get("Squat")).toBe(squat);
    expect(rowByStoredLift.get("Front Squat")).toBe(squat);
  });

  it("keeps a removed spec lift's own row", () => {
    const { rowByStoredLift } = resolveDayPrescriptions(dayRows, [{ lift: "Deadlift", action: "remove" }]);
    expect(rowByStoredLift.get("Deadlift")).toBe(deadlift);
  });

  it("gives an added lift, and a lift swapped into its slot, no row (#1026)", () => {
    const { rowByStoredLift } = resolveDayPrescriptions(dayRows, [
      { lift: "Curl", action: "add" },
      replace("Curl", "Hammer Curl"),
    ]);
    expect(rowByStoredLift.has("Curl")).toBe(false);
    expect(rowByStoredLift.has("Hammer Curl")).toBe(false);
  });

  it("plans nothing and prescribes nothing for a day with no rows", () => {
    const { planned, rowByStoredLift } = resolveDayPrescriptions([], [replace("Squat", "Front Squat")]);
    expect(planned).toEqual([]);
    expect(rowByStoredLift.size).toBe(0);
  });
});
