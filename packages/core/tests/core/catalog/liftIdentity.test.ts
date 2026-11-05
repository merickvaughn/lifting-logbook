import {
  LIFT_CATALOG,
  currentMaxesByLiftId,
  isSameLift,
  liftIdFor,
  parseTrainingMaxes,
  validateTrainingMaxImport,
} from "@src/core";
import { loadCsvFixture } from "../../testUtils";

describe("liftIdFor (#1118)", () => {
  it.each([
    ["Bench Press", "bench-press"],
    ["Bench P.", "bench-press"],
    ["bench-press", "bench-press"],
    // The names that differ between the slot map and the catalog.
    ["Squat", "back-squat"],
    ["Back Squat", "back-squat"],
    ["back-squat", "back-squat"],
    ["Cable Curls", "cable-curl"],
    ["Cable Curl", "cable-curl"],
    ["Face Pulls", "face-pull"],
    ["Face Pull", "face-pull"],
    ["Cable Lat Raise", "lateral-raise"],
    ["Lateral Raise", "lateral-raise"],
    ["Dips", "dip"],
    ["Dip", "dip"],
    // A preset name that is a per-entry alias.
    ["Calf Raises", "calf-raise"],
  ])("resolves %s to %s", (name, id) => {
    expect(liftIdFor(name)).toBe(id);
  });

  it("resolves every catalog lift's name and id to that id", () => {
    for (const lift of LIFT_CATALOG) {
      expect(liftIdFor(lift.name)).toBe(lift.id);
      expect(liftIdFor(lift.id)).toBe(lift.id);
    }
  });

  it("passes through a custom lift or an unknown name", () => {
    expect(liftIdFor("Wide-Grip CBL Curls")).toBe("Wide-Grip CBL Curls");
    expect(liftIdFor("11111111-1111-1111-1111-111111111111")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("is not fooled by an Object.prototype member", () => {
    expect(liftIdFor("toString")).toBe("toString");
    expect(liftIdFor("__proto__")).toBe("__proto__");
  });
});

describe("isSameLift (#1118)", () => {
  it("matches two spellings of one lift", () => {
    expect(isSameLift("Bench P.", "bench-press")).toBe(true);
    expect(isSameLift("Squat", "Back Squat")).toBe(true);
  });

  it("keeps a substitute, which is its own catalog lift, apart from the lift it replaces", () => {
    expect(isSameLift("Romanian Deadlift", "Deadlift")).toBe(false);
  });

  it("keeps OH Press and OH Press-HV apart, since a program can plan both", () => {
    expect(isSameLift("OH Press", "OH Press-HV")).toBe(false);
    expect(isSameLift("OH Press", "overhead-press")).toBe(true);
  });

  it("keeps every lift the RPT fixture's training maxes list distinct, other than by spelling", () => {
    const names = parseTrainingMaxes(loadCsvFixture("training_maxes.csv")).map((m) => m.lift);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names.map(liftIdFor)).size).toBe(new Set(names).size);
  });
});

describe("currentMaxesByLiftId (#1118)", () => {
  const max = (lift: string, weight: number, dateUpdated?: string) => ({
    lift,
    weight,
    ...(dateUpdated !== undefined && { dateUpdated }),
  });

  it("finds a max stored by id from the program's name", () => {
    const current = currentMaxesByLiftId([max("bench-press", 200, "2025-12-29")]);
    expect(current.get(liftIdFor("Bench Press"))?.weight).toBe(200);
  });

  it("finds the max a real import of Bench P. stores", () => {
    const { valid, errors } = validateTrainingMaxImport([
      { lift: "Bench P.", weight: 200, unit: "lbs", dateUpdated: new Date("2025-12-29") },
    ] as never);
    expect(errors).toEqual([]);
    expect(valid[0]?.lift).toBe("bench-press");
    expect(currentMaxesByLiftId(valid).get(liftIdFor("Bench Press"))?.weight).toBe(200);
  });

  it("takes the most recently updated of two rows for one lift, in either order", () => {
    const older = max("Bench Press", 225, "2025-01-01");
    const newer = max("bench-press", 200, "2025-12-29");
    expect(currentMaxesByLiftId([older, newer]).get("bench-press")?.weight).toBe(200);
    expect(currentMaxesByLiftId([newer, older]).get("bench-press")?.weight).toBe(200);
  });

  it("takes the first row on a date tie or a missing date", () => {
    expect(
      currentMaxesByLiftId([max("Squat", 1, "2025-01-01"), max("back-squat", 2, "2025-01-01")]).get("back-squat")
        ?.weight,
    ).toBe(1);
    expect(currentMaxesByLiftId([max("Squat", 1), max("back-squat", 2)]).get("back-squat")?.weight).toBe(1);
  });

  it("accepts Date as well as string dates", () => {
    const rows = [
      { lift: "Deadlift", weight: 1, dateUpdated: new Date("2025-01-01") },
      { lift: "deadlift", weight: 2, dateUpdated: new Date("2025-06-01") },
    ];
    expect(currentMaxesByLiftId(rows).get("deadlift")?.weight).toBe(2);
  });

  it("does not read an OH Press max as OH Press-HV's", () => {
    const current = currentMaxesByLiftId([max("overhead-press", 115, "2025-12-29")]);
    expect(current.get(liftIdFor("OH Press"))?.weight).toBe(115);
    expect(current.get(liftIdFor("OH Press-HV"))).toBeUndefined();
  });
});
