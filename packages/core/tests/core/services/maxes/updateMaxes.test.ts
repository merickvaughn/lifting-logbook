import {
  LiftingProgramSpec,
  parseLiftingProgramSpec,
  parseLiftRecords,
  parseTrainingMaxes,
  TrainingMax,
  updateMaxes,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

// The fixtures' program, which isn't a registered preset, so its workouts number the
// stored one-week block's days; none of these records has a lift override.
const RPT = { program: "RPT", liftOverrides: new Map() };

describe("updateMaxes", () => {
  it("updates only the correct training maxes and leaves others unchanged", () => {
    const tmData = loadCsvFixture("training_maxes.csv");
    const specData = loadCsvFixture("rpt_program_spec.csv");
    const liftData = loadCsvFixture("lift_records_week_1_20260105.csv");
    const newTmData = loadCsvFixture("training_maxes_20260105.csv");
    const trainingMaxes = parseTrainingMaxes(tmData);
    const expectedMaxes = parseTrainingMaxes(newTmData);
    const programSpec = parseLiftingProgramSpec(specData);
    const liftRecords = parseLiftRecords(liftData);
    const { maxes: updatedMaxes, flagged } = updateMaxes(programSpec, trainingMaxes, liftRecords, RPT);
    expect(Array.isArray(updatedMaxes)).toBe(true);
    expect(updatedMaxes.length).toBe(trainingMaxes.length);
    expect(Array.isArray(flagged)).toBe(true);

    // Check that at least one max was updated (date or weight changed)
    const changed = updatedMaxes.some(
      (um, i) =>
        um.weight !== trainingMaxes[i]!.weight ||
        um.dateUpdated.getTime() !== trainingMaxes[i]!.dateUpdated.getTime(),
    );
    expect(changed).toBe(true);

    // Lifts whose computed new TM is an increase — applied directly
    const expectedUpdates: TrainingMax[] = [
      { lift: "BB Row", dateUpdated: new Date("2026-01-05"), weight: 180 },
      { lift: "Calf Raise", dateUpdated: new Date("2026-01-05"), weight: 220 },
      { lift: "C. Lat Raise", dateUpdated: new Date("2026-01-05"), weight: 13.75 },
    ];

    // Lifts whose computed new TM would be a reduction — flagged, not applied
    const expectedFlagged = [
      { lift: "Chin-up",  currentWeight: 245,   proposedWeight: 227.5 },
      { lift: "Dip",      currentWeight: 237.5,  proposedWeight: 227.5 },
      { lift: "Deadlift", currentWeight: 275,    proposedWeight: 267.5 },
    ];
    for (const ef of expectedFlagged) {
      const entry = flagged.find((f) => f.lift === ef.lift);
      expect(entry).toBeDefined();
      expect(entry!.currentWeight).toBe(ef.currentWeight);
      expect(entry!.proposedWeight).toBe(ef.proposedWeight);
    }

    // Check each lift
    trainingMaxes.forEach((orig, i) => {
      const updated = updatedMaxes[i]!;
      const lift = orig.lift;
      const updatedLiftIdx = expectedUpdates.findIndex(
        (eu) => eu.lift === lift,
      );
      if (updatedLiftIdx !== -1) {
        // Compare only the date part in UTC to avoid timezone issues
        expect(updated.dateUpdated.toISOString().slice(0, 10)).toBe(
          expectedUpdates[updatedLiftIdx]!.dateUpdated
            .toISOString()
            .slice(0, 10),
        );
        expect(updated.weight).toBe(expectedUpdates[updatedLiftIdx]!.weight);
      } else {
        // Should remain unchanged
        expect(updated.dateUpdated).toEqual(orig.dateUpdated);
        expect(updated.weight).toBe(orig.weight);
      }
    });
    expect(updatedMaxes).toEqual(expectedMaxes);
    // Test for idempotency by re-running with updated maxes
    expect(updateMaxes(programSpec, updatedMaxes, liftRecords, RPT).maxes).toEqual(
      expectedMaxes,
    );
  });

  it("test week: final set weight becomes new TM with no increment", () => {
    const tmData = loadCsvFixture("training_maxes.csv");
    const specData = loadCsvFixture("rpt_program_spec_test_week.csv");
    const liftData = loadCsvFixture("lift_records_test_week.csv");
    const expectedData = loadCsvFixture("training_maxes_test_week.csv");
    const trainingMaxes = parseTrainingMaxes(tmData);
    const programSpec = parseLiftingProgramSpec(specData);
    const liftRecords = parseLiftRecords(liftData);
    const expectedMaxes = parseTrainingMaxes(expectedData);

    const { maxes: updated } = updateMaxes(programSpec, trainingMaxes, liftRecords, RPT);
    expect(updated).toEqual(expectedMaxes);

    // Specifically verify no increment was applied
    const benchMax = updated.find((m) => m.lift === "Bench P.")!;
    expect(benchMax.weight).toBe(185); // final set weight, not 185 + 2.5 increment
  });

  it("test week: skips update when final set notes flag abnormal condition", () => {
    const tmData = loadCsvFixture("training_maxes.csv");
    const specData = loadCsvFixture("rpt_program_spec_test_week.csv");
    const trainingMaxes = parseTrainingMaxes(tmData);
    const programSpec = parseLiftingProgramSpec(specData);

    // All 5 sets flagged as injury
    const liftRecords = [1, 2, 3, 4, 5].map((setNum) => ({
      program: "RPT",
      macrocycleNum: 1,
      workoutNum: 1,
      date: new Date("2026-01-05"),
      lift: "Bench P." as const,
      setNum,
      weight: 100 + setNum * 20,
      reps: setNum === 5 ? 1 : 3,
      notes: "injury",
    }));

    const { maxes: updated } = updateMaxes(programSpec, trainingMaxes, liftRecords, RPT);
    const benchMax = updated.find((m) => m.lift === "Bench P.")!;
    const originalBenchMax = trainingMaxes.find((m) => m.lift === "Bench P.")!;
    expect(benchMax.weight).toBe(originalBenchMax.weight); // unchanged
  });

  it("deload week: returns maxes unchanged", () => {
    const tmData = loadCsvFixture("training_maxes.csv");
    const specData = loadCsvFixture("rpt_program_spec_deload_week.csv");
    const trainingMaxes = parseTrainingMaxes(tmData);
    const programSpec = parseLiftingProgramSpec(specData);

    // A completed deload set — should never update the max
    const liftRecords = [1, 2, 3].map((setNum) => ({
      program: "RPT",
      macrocycleNum: 1,
      workoutNum: 1,
      date: new Date("2026-01-05"),
      lift: "Bench P." as const,
      setNum,
      weight: 100,
      reps: 5,
      notes: "",
    }));

    const { maxes: updated } = updateMaxes(programSpec, trainingMaxes, liftRecords, RPT);
    const benchMax = updated.find((m) => m.lift === "Bench P.")!;
    const originalBenchMax = trainingMaxes.find((m) => m.lift === "Bench P.")!;
    expect(benchMax.weight).toBe(originalBenchMax.weight);
    expect(benchMax.dateUpdated).toEqual(originalBenchMax.dateUpdated);
  });
});

describe("updateMaxes — a record's prescription is its workout day's (issue #1028)", () => {
  const row = (
    week: number,
    offset: number,
    lift: string,
    reps: number,
    increment: number,
  ): LiftingProgramSpec => ({
    week,
    offset,
    lift,
    increment,
    order: 1,
    sets: 3,
    reps,
    amrap: true,
    warmUpPct: "",
    wtDecrementPct: 0,
    activation: "",
  });
  const set1 = (workoutNum: number, lift: string, weight: number, reps: number) => ({
    program: "5-3-1",
    macrocycleNum: 1,
    workoutNum,
    date: new Date("2026-05-01"),
    lift,
    setNum: 1,
    weight,
    reps,
    notes: "",
  });
  const max = (lift: string, weight: number): TrainingMax => ({
    lift,
    weight,
    dateUpdated: new Date("2026-04-01"),
  });
  const replace = (lift: string, replacedBy: string) => ({
    lift,
    action: "replace" as const,
    replacedBy,
  });
  const fiveThreeOne = (liftOverrides = new Map<number, ReturnType<typeof replace>[]>()) => ({
    program: "5-3-1",
    liftOverrides,
  });

  it("progresses a Manage Lifts replacement's own training max by its slot's rules", () => {
    const spec = [row(1, 0, "Deadlift", 5, 10), row(1, 2, "Squat", 5, 5)];

    const { maxes } = updateMaxes(
      spec,
      [max("Deadlift", 300), max("Rack Pull", 350)],
      [set1(1, "Rack Pull", 360, 5)],
      fiveThreeOne(new Map([[1, [replace("Deadlift", "Rack Pull")]]])),
    );

    expect(maxes).toEqual([
      max("Deadlift", 300),
      { lift: "Rack Pull", weight: 370, dateUpdated: new Date("2026-05-01") },
    ]);
  });

  it("gives sets logged under a chain's earlier name the slot's prescription", () => {
    // Squat → Front Squat → Box Squat. The sets were logged while the slot held Front
    // Squat, which the spec doesn't name: they take Squat's row and progress Front
    // Squat's own max.
    const spec = [row(1, 0, "Squat", 5, 5)];

    const { maxes } = updateMaxes(
      spec,
      [max("Squat", 250), max("Front Squat", 200), max("Box Squat", 220)],
      [set1(1, "Front Squat", 210, 5)],
      fiveThreeOne(new Map([[1, [replace("Squat", "Front Squat"), replace("Front Squat", "Box Squat")]]])),
    );

    expect(maxes).toEqual([
      max("Squat", 250),
      { lift: "Front Squat", weight: 215, dateUpdated: new Date("2026-05-01") },
      max("Box Squat", 220),
    ]);
  });

  it("reads a tiled program week's prescription from its block week", () => {
    // A 3-week block across 5-3-1's 12 weeks, one day a week: workout 6 is program
    // week 6, which tiles from block week 3 (1 rep), not week 1 (5 reps).
    const spec = [row(1, 0, "Squat", 5, 5), row(2, 0, "Squat", 3, 5), row(3, 0, "Squat", 1, 5)];

    const { maxes } = updateMaxes(spec, [max("Squat", 250)], [set1(6, "Squat", 260, 1)], fiveThreeOne());

    expect(maxes).toEqual([{ lift: "Squat", weight: 265, dateUpdated: new Date("2026-05-01") }]);
  });

  it("reads the prescription of the record's own day when a lift trains on two days", () => {
    const spec = [row(1, 0, "Squat", 8, 5), row(1, 2, "Squat", 3, 5)];

    const { maxes } = updateMaxes(spec, [max("Squat", 250)], [set1(2, "Squat", 260, 3)], fiveThreeOne());

    expect(maxes).toEqual([{ lift: "Squat", weight: 265, dateUpdated: new Date("2026-05-01") }]);
  });

  it("progresses a lift a day plans twice from its first occurrence only (issue #1027)", () => {
    // Squat for 5 reps, then Squat again for 12 lighter reps as extra volume. The
    // second occurrence's set 1 meets the first row's 5 reps at a lower weight; read
    // under the first row, it would take the training max down and flag a reduction.
    const spec = [row(1, 0, "Squat", 5, 5), row(1, 0, "Squat", 12, 5)];

    const { maxes, flagged } = updateMaxes(
      spec,
      [max("Squat", 250)],
      [{ ...set1(1, "Squat", 150, 12), occurrence: 1 }, set1(1, "Squat", 260, 5)],
      fiveThreeOne(),
    );

    expect(maxes).toEqual([{ lift: "Squat", weight: 265, dateUpdated: new Date("2026-05-01") }]);
    expect(flagged).toEqual([]);
  });

  it("takes the week type from the record's block week", () => {
    const spec = [
      row(1, 0, "Squat", 5, 5),
      { ...row(2, 0, "Squat", 5, 5), weekType: "deload" as const },
    ];

    const { maxes } = updateMaxes(spec, [max("Squat", 250)], [set1(4, "Squat", 260, 5)], fiveThreeOne());

    expect(maxes).toEqual([max("Squat", 250)]);
  });
});

describe("updateMaxes — lookup semantics (issue #983)", () => {
  function baseline() {
    const trainingMaxes = parseTrainingMaxes(loadCsvFixture("training_maxes.csv"));
    const programSpec = parseLiftingProgramSpec(loadCsvFixture("rpt_program_spec.csv"));
    const liftRecords = parseLiftRecords(loadCsvFixture("lift_records_week_1_20260105.csv"));
    return { trainingMaxes, programSpec, liftRecords };
  }

  it("flags reductions in record iteration order, exactly", () => {
    // The hoisted lookups must not change *which* record decides a lift or in
    // what order the flags are pushed: the sequence is the order those lifts'
    // set-1 records appear in the input, which is what the per-record scan produced.
    const { trainingMaxes, programSpec, liftRecords } = baseline();
    const { flagged } = updateMaxes(programSpec, trainingMaxes, liftRecords, RPT);
    const flaggedLifts = new Set(["Chin-up", "Dip", "Deadlift"]);
    const expectedOrder = liftRecords
      .filter((r) => r.setNum === 1 && flaggedLifts.has(r.lift))
      .map((r) => r.lift);
    expect(flagged.map((f) => f.lift)).toEqual(expectedOrder);
    expect(flagged).toHaveLength(3);
  });

  it("uses the first entry when a lift appears twice in the training maxes, leaving the second untouched", () => {
    const { trainingMaxes, programSpec, liftRecords } = baseline();
    const squat = trainingMaxes.find((tm) => tm.lift === "Deadlift");
    if (!squat) throw new Error("fixture has no Deadlift max");
    const duplicated = [...trainingMaxes, { ...squat, weight: 999 }];

    const { maxes } = updateMaxes(programSpec, duplicated, liftRecords, RPT);

    const [first, second] = maxes.filter((m) => m.lift === "Deadlift");
    // Deadlift is a flagged reduction in this fixture: the first entry is the
    // one consulted (and left at its weight), the duplicate is never touched.
    expect(first?.weight).toBe(squat.weight);
    expect(second?.weight).toBe(999);
  });

  it("reports a missing training max before a missing spec, and a missing max even on a deload spec", () => {
    const { trainingMaxes, programSpec, liftRecords } = baseline();
    const withoutDeadliftMax = trainingMaxes.filter((tm) => tm.lift !== "Deadlift");
    expect(() => updateMaxes(programSpec, withoutDeadliftMax, liftRecords, RPT)).toThrow(
      "Training max for lift Deadlift not found.",
    );

    const withoutDeadliftSpec = programSpec.filter((ps) => ps.lift !== "Deadlift");
    expect(() => updateMaxes(withoutDeadliftSpec, trainingMaxes, liftRecords, RPT)).toThrow(
      "Program spec for lift Deadlift not found.",
    );

    const deloadSpec = programSpec.map((ps) => ({ ...ps, weekType: "deload" as const }));
    expect(() => updateMaxes(deloadSpec, withoutDeadliftMax, liftRecords, RPT)).toThrow(
      "Training max for lift Deadlift not found.",
    );
  });
});
