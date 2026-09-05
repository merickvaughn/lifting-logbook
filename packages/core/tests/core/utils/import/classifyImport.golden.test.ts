import { classifyImport } from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

/**
 * Golden outputs for the classifier, captured on the pre-#983 implementation.
 *
 * The existing suite pins only `type`, `bucket` and `confidence > 0.7`, which
 * is too weak to prove a refactor preserved the *scores*. These pin the full
 * `ImportClassification` — confidence, bucket, every reason string in order,
 * and every alternative with its close-call flag — for each shipped fixture plus
 * a table no profile matches. Deliberately kept after the refactor: they also
 * guard the thresholds in importThresholds.ts. A change that moves any of these
 * on purpose must update the literal and say why.
 */
const AMBIGUOUS = [["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]];

describe("classifyImport — golden outputs", () => {
  it("lift_records.csv", () => {
    expect(classifyImport(loadCsvFixture("lift_records.csv"))).toEqual({
      type: "lift-records",
      confidence: 1,
      bucket: "high",
      reasons: [
        "Matched 9/9 expected columns (program, cycle, workout, set, reps, weight, date, lift, notes)",
        "Distinctive markers: cycle, workout, set",
        "100% of values matched known lifts",
        "9 columns (≈9 expected)"
      ],
      alternatives: [
        {
          type: "program-spec",
          confidence: 0.247,
          closeCall: false
        },
        {
          type: "training-maxes",
          confidence: 0.05,
          closeCall: false
        },
        {
          type: "strength-goals",
          confidence: 0,
          closeCall: false
        }
      ]
    });
  });

  it("training_maxes.csv", () => {
    expect(classifyImport(loadCsvFixture("training_maxes.csv"))).toEqual({
      type: "training-maxes",
      confidence: 1,
      bucket: "high",
      reasons: [
        "Matched 4/4 expected columns (date updated, date, lift, weight)",
        "Distinctive marker: date updated",
        "100% of values matched known lifts",
        "3 columns (≈3 expected)"
      ],
      alternatives: [
        {
          type: "lift-records",
          confidence: 0.4333,
          closeCall: false
        },
        {
          type: "strength-goals",
          confidence: 0.1756,
          closeCall: false
        },
        {
          type: "program-spec",
          confidence: 0.0962,
          closeCall: false
        }
      ]
    });
  });

  it("rpt_program_spec.csv", () => {
    expect(classifyImport(loadCsvFixture("rpt_program_spec.csv"))).toEqual({
      type: "program-spec",
      confidence: 0.8983,
      bucket: "medium",
      reasons: [
        "Matched 11/12 expected columns (week, offset, increment, order, sets, reps, amrap, warm-up, decrement, activation, lift)",
        "Distinctive markers: warm-up, amrap, activation, decrement",
        "11 columns (≈11 expected)"
      ],
      alternatives: [
        {
          type: "lift-records",
          confidence: 0.5667,
          closeCall: false
        },
        {
          type: "strength-goals",
          confidence: 0.0556,
          closeCall: false
        },
        {
          type: "training-maxes",
          confidence: 0,
          closeCall: false
        }
      ]
    });
  });

  it("strength_goals.csv", () => {
    expect(classifyImport(loadCsvFixture("strength_goals.csv"))).toEqual({
      type: "strength-goals",
      confidence: 0.8889,
      bucket: "high",
      reasons: [
        "Matched 7/9 expected columns (goal, current tm, intermediate, advanced, elite, lift, start date)",
        "Distinctive markers: intermediate, advanced, elite, current tm, goal date",
        "5 columns (≈5 expected)"
      ],
      alternatives: [
        {
          type: "training-maxes",
          confidence: 0.275,
          closeCall: false
        },
        {
          type: "lift-records",
          confidence: 0.2528,
          closeCall: false
        },
        {
          type: "program-spec",
          confidence: 0.0909,
          closeCall: false
        }
      ]
    });
  });

  it("ambiguous", () => {
    expect(classifyImport(AMBIGUOUS)).toEqual({
      type: null,
      confidence: 0.15,
      bucket: "low",
      reasons: [
        "3 columns (≈3 expected)"
      ],
      alternatives: [
        {
          type: "strength-goals",
          confidence: 0.12,
          closeCall: true
        },
        {
          type: "program-spec",
          confidence: 0.0545,
          closeCall: true
        },
        {
          type: "lift-records",
          confidence: 0.05,
          closeCall: true
        }
      ]
    });
  });
});
