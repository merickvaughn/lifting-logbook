import { classifyImport } from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("classifyImport", () => {
  it("routes the lift-history fixture to lift-records with reasons", () => {
    const result = classifyImport(loadCsvFixture("lift_records.csv"));
    expect(result.type).toBe("lift-records");
    expect(result.bucket).toBe("high");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.alternatives.length).toBe(3);
  });

  // The Google Sheets import derives a below-auto-accept tab's top kind as the one
  // kind missing from `alternatives` (#1111), so every other kind must be listed.
  it("lists every kind except the top scorer as an alternative, even with no winner", () => {
    const kinds = ["lift-records", "training-maxes", "strength-goals", "program-spec"];
    for (const table of [loadCsvFixture("lift_records.csv"), [["foo", "bar"], ["1", "2"]]]) {
      const result = classifyImport(table);
      const listed = result.alternatives.map((a) => a.type);
      expect(new Set(listed).size).toBe(kinds.length - 1);
      expect(listed.every((k) => kinds.includes(k))).toBe(true);
    }
  });

  it("routes the training-maxes fixture to training-maxes", () => {
    const result = classifyImport(loadCsvFixture("training_maxes.csv"));
    expect(result.type).toBe("training-maxes");
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("routes the program-spec fixture to program-spec", () => {
    const result = classifyImport(loadCsvFixture("rpt_program_spec.csv"));
    expect(result.type).toBe("program-spec");
  });

  it("routes the transposed strength-goals fixture to strength-goals", () => {
    const result = classifyImport(loadCsvFixture("strength_goals.csv"));
    expect(result.type).toBe("strength-goals");
  });

  it("returns a null type and low bucket for an ambiguous table", () => {
    const result = classifyImport([
      ["Foo", "Bar"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(result.type).toBeNull();
    expect(result.bucket).toBe("low");
  });

  it("flags a runner-up within the close-call margin", () => {
    const result = classifyImport(loadCsvFixture("lift_records.csv"));
    // Every alternative exposes its own confidence and a closeCall flag.
    for (const alt of result.alternatives) {
      expect(typeof alt.confidence).toBe("number");
      expect(typeof alt.closeCall).toBe("boolean");
    }
  });
});
