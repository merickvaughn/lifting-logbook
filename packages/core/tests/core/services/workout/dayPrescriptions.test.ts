import type { LiftOverride } from "@src/core/models/LiftOverride";
import {
  liftOccurrences,
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

  it("gives each occurrence of a lift the day repeats its own row, in order (#1027)", () => {
    const second = { lift: "Squat", reps: 1 };
    expect(
      plannedLiftRows([squat, bench, second], [{ lift: "Squat" }, { lift: "Bench Press" }, { lift: "Squat" }]),
    ).toEqual([squat, bench, second]);
  });

  it("matches a swapped repeated slot's occurrences to the slot's rows (#1027)", () => {
    const second = { lift: "Squat", reps: 1 };
    expect(
      plannedLiftRows(
        [squat, second],
        [
          { lift: "Front Squat", replaces: "Squat" },
          { lift: "Front Squat", replaces: "Squat" },
        ],
      ),
    ).toEqual([squat, second]);
  });

  it("gives an occurrence past the day's rows for its lift no row", () => {
    expect(plannedLiftRows(dayRows, [{ lift: "Squat" }, { lift: "Squat" }])).toEqual([squat, undefined]);
  });
});

describe("liftOccurrences", () => {
  it("numbers each lift's occurrences from 0, index-aligned", () => {
    expect(
      liftOccurrences([{ lift: "Squat" }, { lift: "Bench Press" }, { lift: "Squat" }, { lift: "Squat" }]),
    ).toEqual([0, 0, 1, 2]);
  });
});

describe("resolveDayPrescriptions", () => {
  it("lists every spec lift in the day's order, a repeated one twice, with no overrides (#1027)", () => {
    const second = { lift: "Squat", reps: 1 };
    const { planned, rowByStoredLift } = resolveDayPrescriptions([squat, bench, second], []);
    expect(planned).toEqual([{ lift: "Squat" }, { lift: "Bench Press" }, { lift: "Squat" }]);
    // Progression follows a repeated lift's first occurrence.
    expect(rowByStoredLift).toEqual(new Map([["Squat", squat], ["Bench Press", bench]]));
  });

  it("swaps every occurrence of a repeated lift, each keeping its own slot's row", () => {
    const second = { lift: "Squat", reps: 1 };
    const { planned, renamed, rowByStoredLift } = resolveDayPrescriptions(
      [squat, second],
      [replace("Squat", "Front Squat")],
    );
    expect(planned).toEqual([
      { lift: "Front Squat", replaces: "Squat" },
      { lift: "Front Squat", replaces: "Squat" },
    ]);
    expect(plannedLiftRows([squat, second], planned)).toEqual([squat, second]);
    expect(renamed).toEqual(new Map([["Squat", "Front Squat"]]));
    // Progression follows the first occurrence.
    expect(rowByStoredLift.get("Front Squat")).toBe(squat);
  });

  it("progresses a lift a swap duplicates by its own slot's row, not the swapped slot's (#1109)", () => {
    const frontSquat = { lift: "Front Squat", reps: 8 };
    const { planned, rowByStoredLift } = resolveDayPrescriptions(
      [frontSquat, squat],
      [replace("Front Squat", "Squat")],
    );
    expect(planned).toEqual([{ lift: "Squat", replaces: "Front Squat" }, { lift: "Squat" }]);
    expect(rowByStoredLift.get("Squat")).toBe(squat);
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
