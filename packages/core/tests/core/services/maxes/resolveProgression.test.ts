import {
  builtInLiftFor,
  resolveProgression,
  type LiftProgressionMeta,
  type ProgressionRow,
  type UserProgressionDefault,
} from "@src/core";
import { DEFAULT_WEIGHT_INCREMENT } from "@lifting-logbook/types";

// Issue #1209. Each source names a different type, so the winner is unambiguous.
const row: ProgressionRow = { progression: "amrap_gated", repsLow: 6, reps: 8, increment: 2.5 };
const liftMeta: LiftProgressionMeta = { progression: "double", progressionIncrement: 5, repsLow: 10, repsHigh: 15 };
const userDefault: UserProgressionDefault = { type: "percent_wave", increment: 10, repsLow: 3, repsHigh: 5 };
const catalogLift = { progression: { type: "manual" as const } };

describe("resolveProgression", () => {
  describe("type and rep range: row, then lift, then user default, then catalog, then amrap_gated", () => {
    it("takes the row's when it names one, with the row's reps as the top of its range", () => {
      expect(resolveProgression(row, liftMeta, userDefault, catalogLift, 1.25)).toEqual({
        type: "amrap_gated", repsLow: 6, repsHigh: 8, increment: 2.5, source: "row",
      });
    });

    it("takes the lift's own when the row names none", () => {
      const unnamedRow: ProgressionRow = { reps: 8, increment: 2.5 };
      expect(resolveProgression(unnamedRow, liftMeta, userDefault, catalogLift)).toMatchObject({
        type: "double", repsLow: 10, repsHigh: 15, source: "lift",
      });
    });

    it("takes the lifter's default when the lift has none of its own", () => {
      const noType: LiftProgressionMeta = { progression: null, progressionIncrement: 5 };
      expect(resolveProgression(null, noType, userDefault, catalogLift)).toMatchObject({
        type: "percent_wave", repsLow: 3, repsHigh: 5, source: "user",
      });
    });

    it("takes the catalog's when the lifter's default is unset", () => {
      expect(resolveProgression(null, null, null, catalogLift)).toMatchObject({
        type: "manual", repsLow: null, repsHigh: null, source: "catalog",
      });
    });

    it("falls back to amrap_gated with no range when nothing names a type", () => {
      expect(resolveProgression(null, null, null, null)).toEqual({
        type: "amrap_gated", repsLow: null, repsHigh: null, increment: DEFAULT_WEIGHT_INCREMENT, source: "fallback",
      });
    });

    it("lets the lifter's default override the catalog for a built-in", () => {
      const cableCurl = builtInLiftFor("Cable Curl");
      expect(cableCurl).toBeDefined();
      expect(resolveProgression(null, null, null, cableCurl)).toMatchObject({
        type: "double", repsLow: 8, repsHigh: 12, source: "catalog",
      });
      expect(resolveProgression(null, null, { type: "linear", repsHigh: 5 }, cableCurl)).toMatchObject({
        type: "linear", repsLow: null, repsHigh: 5, source: "user",
      });
    });

    it("keeps a program row on amrap_gated when the lifter's default is linear", () => {
      const rptRow: ProgressionRow = { progression: "amrap_gated", reps: 6, increment: 2.5 };
      expect(resolveProgression(rptRow, null, { type: "linear", repsHigh: 5 }, null)).toMatchObject({
        type: "amrap_gated", repsHigh: 6, source: "row",
      });
    });
  });

  describe("increment, resolved separately from the type", () => {
    it("uses the row's increment inside a program and the lift's own off it", () => {
      const lift: LiftProgressionMeta = { progression: "linear", progressionIncrement: 5, repsHigh: 5 };
      const programRow: ProgressionRow = { reps: 5, increment: 2.5 };
      expect(resolveProgression(programRow, lift, null, null).increment).toBe(2.5);
      expect(resolveProgression(null, lift, null, null).increment).toBe(5);
    });

    it("uses the row's increment whatever source supplied the type", () => {
      const programRow: ProgressionRow = { reps: 5, increment: 2.5 };
      expect(resolveProgression(programRow, liftMeta, null, null)).toMatchObject({ source: "lift", increment: 2.5 });
      expect(resolveProgression(programRow, null, userDefault, null)).toMatchObject({ source: "user", increment: 2.5 });
      expect(resolveProgression(programRow, null, null, catalogLift)).toMatchObject({ source: "catalog", increment: 2.5 });
      expect(resolveProgression(programRow, null, null, null, 5)).toMatchObject({ source: "fallback", increment: 2.5 });
    });

    it("off-program, falls from the lift's increment to the lifter's default's to defaultWeightIncrement", () => {
      expect(resolveProgression(null, { progressionIncrement: 5 }, { type: "linear", increment: 10 }, null, 0.625).increment).toBe(5);
      expect(resolveProgression(null, { progressionIncrement: null }, { type: "linear", increment: 10 }, null, 0.625).increment).toBe(10);
      expect(resolveProgression(null, null, { type: "linear" }, null, 0.625).increment).toBe(0.625);
      expect(resolveProgression(null, null, null, null, null).increment).toBe(DEFAULT_WEIGHT_INCREMENT);
    });

    it("takes the lift's increment even when its type comes from elsewhere", () => {
      // The lift sets only an increment, so the type comes from the catalog.
      expect(resolveProgression(null, { progressionIncrement: 5 }, null, catalogLift, 1.25)).toMatchObject({
        type: "manual", source: "catalog", increment: 5,
      });
    });

    it("falls back to defaultWeightIncrement on its own, while the catalog supplies the type", () => {
      expect(resolveProgression(null, null, null, catalogLift, 2.5)).toMatchObject({
        type: "manual", source: "catalog", increment: 2.5,
      });
    });
  });
});
