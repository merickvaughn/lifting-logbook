import {
  LIFT_CATALOG,
  TrainingMax,
  currentMaxLookup,
  isSameLift,
  liftIdFor,
  lookupByLift,
  validateTrainingMaxImport,
} from "@src/core";

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

  it("treats OH Press-HV as Overhead Press: a high-volume slot of the same lift (#1140)", () => {
    expect(isSameLift("OH Press", "OH Press-HV")).toBe(true);
    expect(isSameLift("OH Press-HV", "overhead-press")).toBe(true);
  });
});

describe("lookupByLift (#1118)", () => {
  const lookup = lookupByLift([
    ["C. Lat Raise", 1],
    ["Lateral Raise", 2],
    ["Bench Press", 3],
    ["Bench Press", 4],
  ]);

  it("prefers the exact name, so two spellings planned as slots keep their own rows", () => {
    expect(lookup("C. Lat Raise")).toBe(1);
    expect(lookup("Lateral Raise")).toBe(2);
  });

  it("falls back to the first entry for the same lift", () => {
    expect(lookup("lateral-raise")).toBe(1);
    expect(lookup("bench-press")).toBe(3);
  });

  it("misses a lift it has no entry for", () => {
    expect(lookup("Deadlift")).toBeUndefined();
  });
});

describe("currentMaxLookup (#1118)", () => {
  const max = (lift: string, weight: number, dateUpdated = "2025-12-29") => ({ lift, weight, dateUpdated });
  const weightFor = (rows: ReturnType<typeof max>[], name: string) => currentMaxLookup(rows)(name)?.weight;

  it("finds a max stored by id from the program's name", () => {
    expect(weightFor([max("bench-press", 200)], "Bench Press")).toBe(200);
  });

  it("finds the max a real import of Bench P. stores", () => {
    const rows: TrainingMax[] = [{ lift: "Bench P." as TrainingMax["lift"], weight: 200, dateUpdated: new Date("2025-12-29") }];
    const { valid, errors } = validateTrainingMaxImport(rows);
    expect(errors).toEqual([]);
    expect(valid[0]?.lift).toBe("bench-press");
    expect(currentMaxLookup(valid)("Bench Press")?.weight).toBe(200);
  });

  it("takes the more recent of the exact row and the id row, in either order", () => {
    const older = max("Bench Press", 225, "2025-01-01");
    const newer = max("bench-press", 200);
    expect(weightFor([older, newer], "Bench Press")).toBe(200);
    expect(weightFor([newer, older], "Bench Press")).toBe(200);
  });

  it("keeps an exact row that is newer than the id row", () => {
    expect(weightFor([max("bench-press", 200, "2025-01-01"), max("Bench Press", 225)], "Bench Press")).toBe(225);
  });

  it("gives a day's tie to the exact row, in either order", () => {
    const exact = max("Bench Press", 225);
    const stored = max("bench-press", 200);
    expect(weightFor([exact, stored], "Bench Press")).toBe(225);
    expect(weightFor([stored, exact], "Bench Press")).toBe(225);
  });

  it("compares by day, so a time of day can't decide it", () => {
    const exact = { lift: "Bench Press", weight: 225, dateUpdated: new Date("2025-12-29T01:00:00Z") };
    const stored = { lift: "bench-press", weight: 200, dateUpdated: new Date("2025-12-29T23:00:00Z") };
    expect(currentMaxLookup([exact, stored])("Bench Press")?.weight).toBe(225);
  });

  it("keeps two slots' own maxes when a program plans both spellings", () => {
    const rows = [max("C. Lat Raise", 12.5, "2025-01-01"), max("Lateral Raise", 25)];
    expect(weightFor(rows, "C. Lat Raise")).toBe(12.5);
    expect(weightFor(rows, "Lateral Raise")).toBe(25);
  });

  it("falls back to another spelling when there is no exact or id row, independent of row order", () => {
    const rows = [max("Back Squat", 300, "2025-01-01"), max("Squat", 315)];
    expect(weightFor([max("Back Squat", 300)], "Squat")).toBe(300);
    expect(weightFor(rows, "back-squat")).toBe(315);
    expect(weightFor([...rows].reverse(), "back-squat")).toBe(315);

    const tied = [max("Back Squat", 300), max("Squat", 315)];
    expect(weightFor(tied, "back-squat")).toBe(300);
    expect(weightFor([...tied].reverse(), "back-squat")).toBe(300);
  });

  it("reads a stored overhead-press max for both OH Press and OH Press-HV", () => {
    const rows = [max("overhead-press", 115)];
    expect(weightFor(rows, "OH Press")).toBe(115);
    expect(weightFor(rows, "OH Press-HV")).toBe(115);
  });

  it("misses a lift with no row", () => {
    expect(weightFor([max("Squat", 315)], "Deadlift")).toBeUndefined();
  });
});
