import {
  LiftingProgramSpec,
  parseLiftingProgramSpec,
  parseLiftRecords,
  parseTrainingMaxes,
  TrainingMax,
  updateMaxes,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

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
    const { maxes: updatedMaxes, flagged } = updateMaxes(programSpec, trainingMaxes, liftRecords);
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
    expect(updateMaxes(programSpec, updatedMaxes, liftRecords).maxes).toEqual(
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

    const { maxes: updated } = updateMaxes(programSpec, trainingMaxes, liftRecords);
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
      cycleNum: 1,
      workoutNum: 1,
      date: new Date("2026-01-05"),
      lift: "Bench P." as const,
      setNum,
      weight: 100 + setNum * 20,
      reps: setNum === 5 ? 1 : 3,
      notes: "injury",
    }));

    const { maxes: updated } = updateMaxes(programSpec, trainingMaxes, liftRecords);
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
      cycleNum: 1,
      workoutNum: 1,
      date: new Date("2026-01-05"),
      lift: "Bench P." as const,
      setNum,
      weight: 100,
      reps: 5,
      notes: "",
    }));

    const { maxes: updated } = updateMaxes(programSpec, trainingMaxes, liftRecords);
    const benchMax = updated.find((m) => m.lift === "Bench P.")!;
    const originalBenchMax = trainingMaxes.find((m) => m.lift === "Bench P.")!;
    expect(benchMax.weight).toBe(originalBenchMax.weight);
    expect(benchMax.dateUpdated).toEqual(originalBenchMax.dateUpdated);
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
    const { flagged } = updateMaxes(programSpec, trainingMaxes, liftRecords);
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

    const { maxes } = updateMaxes(programSpec, duplicated, liftRecords);

    const [first, second] = maxes.filter((m) => m.lift === "Deadlift");
    // Deadlift is a flagged reduction in this fixture: the first entry is the
    // one consulted (and left at its weight), the duplicate is never touched.
    expect(first?.weight).toBe(squat.weight);
    expect(second?.weight).toBe(999);
  });

  it("reports a missing training max before a missing spec, and a missing max even on a deload spec", () => {
    const { trainingMaxes, programSpec, liftRecords } = baseline();
    const withoutDeadliftMax = trainingMaxes.filter((tm) => tm.lift !== "Deadlift");
    expect(() => updateMaxes(programSpec, withoutDeadliftMax, liftRecords)).toThrow(
      "Training max for lift Deadlift not found.",
    );

    const withoutDeadliftSpec = programSpec.filter((ps) => ps.lift !== "Deadlift");
    expect(() => updateMaxes(withoutDeadliftSpec, trainingMaxes, liftRecords)).toThrow(
      "Program spec for lift Deadlift not found.",
    );

    const deloadSpec = programSpec.map((ps) => ({ ...ps, weekType: "deload" as const }));
    expect(() => updateMaxes(deloadSpec, withoutDeadliftMax, liftRecords)).toThrow(
      "Training max for lift Deadlift not found.",
    );
  });
});
