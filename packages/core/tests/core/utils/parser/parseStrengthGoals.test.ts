import { parseStrengthGoals } from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("parseStrengthGoals", () => {
  it("parses the real tier-ladder export into one goal per lift", () => {
    const data = loadCsvFixture("strength_goals.csv");
    const goals = parseStrengthGoals(data);
    expect(goals.map((g) => g.lift)).toEqual([
      "Squat",
      "Bench P.",
      "Chin-up",
      "Deadlift",
      "OH Press",
    ]);
    expect(goals.every((g) => g.goalType === "absolute" && g.unit === "lbs")).toBe(true);
    // Metadata rows (Weight / Start Date / Today's Date / Goal Date / Note) are skipped.
    expect(goals).toHaveLength(5);
  });

  it("targets the next milestone above each lift's Current TM", () => {
    const goals = parseStrengthGoals(loadCsvFixture("strength_goals.csv"));
    const target = (lift: string) => goals.find((g) => g.lift === lift)?.target;
    // Squat TM 250 → Intermediate 280 is the next tier up.
    expect(target("Squat")).toBe(280);
    // Chin-up TM 252.5 already clears Intermediate 210 → next is Advanced 262.5.
    expect(target("Chin-up")).toBe(262.5);
    expect(target("OH Press")).toBe(131.25);
  });

  it("stamps updatedAt from the export's Today's Date", () => {
    const goals = parseStrengthGoals(loadCsvFixture("strength_goals.csv"));
    expect(goals[0]!.updatedAt.getFullYear()).toBe(2026);
  });

  // Regression for issue #899, same root cause and fix as parseTrainingMaxes.ts
  // (#894): a non-ISO cell like "6/9/2026" parsed via bare `new Date(string)`
  // carried whatever non-midnight local-time offset the host happened to be
  // at, instead of exact UTC midnight.
  it("normalizes updatedAt to UTC midnight regardless of the host timezone", () => {
    const goals = parseStrengthGoals(loadCsvFixture("strength_goals.csv"));
    expect(goals[0]!.updatedAt.getUTCHours()).toBe(0);
    expect(goals[0]!.updatedAt.getUTCMinutes()).toBe(0);
    expect(goals[0]!.updatedAt.getUTCSeconds()).toBe(0);
    expect(goals[0]!.updatedAt.getUTCMilliseconds()).toBe(0);
  });

  it("targets the numerically lowest tier above Current TM even when tier columns are out of order", () => {
    const goals = parseStrengthGoals([
      ["Lift", "Current TM", "Elite", "Intermediate", "Advanced"],
      ["Squat", "250", "420", "280", "350"],
    ]);
    // Intermediate (280) is the lowest tier above 250 despite appearing after Elite.
    expect(goals[0]).toMatchObject({ lift: "Squat", target: 280 });
  });

  it("falls back to the top tier when every tier is already cleared", () => {
    const goals = parseStrengthGoals([
      ["Lift", "Current TM", "Intermediate", "Advanced", "Elite"],
      ["Squat", "500", "280", "350", "420"],
    ]);
    expect(goals[0]).toMatchObject({ lift: "Squat", target: 420 });
  });

  it("returns an empty array when there is no Lift header row", () => {
    expect(parseStrengthGoals([])).toEqual([]);
    expect(parseStrengthGoals([["Weight", "175"], ["Squat", "250"]])).toEqual([]);
  });
});
