import { classifyLiftRecordRows } from "@src/core";
import type { LiftRecord } from "@src/core";

// Count-based duplicate detection (proposal decision 13, #1199).

const set = (over: Partial<LiftRecord> = {}): LiftRecord => ({
  program: "p",
  macrocycleNum: 1,
  workoutNum: 1,
  date: new Date("2026-01-01"),
  lift: "back-squat",
  setNum: 1,
  weight: 100,
  reps: 5,
  notes: "",
  ...over,
});

const classify = (rows: LiftRecord[], stored: LiftRecord[] = []) =>
  classifyLiftRecordRows(rows, (r) => r, stored).map(({ kind, occurrence }) => ({ kind, occurrence }));

describe("classifyLiftRecordRows", () => {
  it("skips a re-imported file whatever its macrocycle, workout and program numbers", () => {
    const stored = [set({ program: "other", macrocycleNum: 4, workoutNum: 9 }), set({ setNum: 2 })];
    const file = [set({ macrocycleNum: 3, workoutNum: 2 }), set({ macrocycleNum: 3, setNum: 2 })];
    expect(classify(file, stored)).toEqual([
      { kind: "skip", occurrence: 0 },
      { kind: "skip", occurrence: 0 },
    ]);
  });

  it("matches a set stored under another spelling of the lift", () => {
    expect(classify([set({ lift: "Calf Raises" })], [set({ lift: "calf-raise" })])).toEqual([
      { kind: "skip", occurrence: 0 },
    ]);
  });

  it("does not match a custom lift's name to a built-in lift", () => {
    expect(classify([set({ lift: "Calf Thing" })], [set({ lift: "calf-raise" })])).toEqual([
      { kind: "create", occurrence: 0 },
    ]);
  });

  it("creates only the rows beyond the stored count, pairing identical weight and reps first", () => {
    const stored = [set({ weight: 120 })];
    const file = [set({ weight: 100 }), set({ weight: 120 })];
    expect(classify(file, stored)).toEqual([
      { kind: "create", occurrence: 1 },
      { kind: "skip", occurrence: 0 },
    ]);
  });

  it("leaves a re-exported row whose weight changed as stored", () => {
    expect(classify([set({ weight: 105 })], [set({ weight: 100 })])).toEqual([{ kind: "skip", occurrence: 0 }]);
  });

  it("keeps a second same-day workout apart by giving it the next occurrence", () => {
    const stored = [set({ occurrence: 0 }), set({ occurrence: 1, weight: 90 })];
    const file = [set(), set({ weight: 90 }), set({ weight: 80 })];
    expect(classify(file, stored)).toEqual([
      { kind: "skip", occurrence: 0 },
      { kind: "skip", occurrence: 0 },
      { kind: "create", occurrence: 2 },
    ]);
  });

  it("gives two different sets on one slot in a new file different occurrences", () => {
    expect(classify([set(), set({ reps: 3 })])).toEqual([
      { kind: "create", occurrence: 0 },
      { kind: "create", occurrence: 1 },
    ]);
  });

  it("counts an exact repeat within the file once, unless its occurrence differs", () => {
    expect(classify([set(), set({ workoutNum: 2 })])).toEqual([
      { kind: "create", occurrence: 0 },
      { kind: "skip", occurrence: 0 },
    ]);
    expect(classify([set(), set({ occurrence: 1 })])).toEqual([
      { kind: "create", occurrence: 0 },
      { kind: "create", occurrence: 1 },
    ]);
  });

  it("keeps an extra row's occurrence when no stored row has it", () => {
    const stored = [set({ occurrence: 0, weight: 50 })];
    expect(classify([set({ weight: 50 }), set({ occurrence: 3, weight: 70 })], stored)).toEqual([
      { kind: "skip", occurrence: 0 },
      { kind: "create", occurrence: 3 },
    ]);
  });

  it("counts different dates and set numbers apart", () => {
    const stored = [set()];
    expect(classify([set({ date: new Date("2026-01-02") }), set({ setNum: 2 })], stored)).toEqual([
      { kind: "create", occurrence: 0 },
      { kind: "create", occurrence: 0 },
    ]);
  });

  it("keys a created row by the occurrence it's stored under", () => {
    const [row] = classifyLiftRecordRows([set({ weight: 90 })], (r) => r, [set()]);
    expect(row).toMatchObject({ kind: "skip" });
    const [extra] = classifyLiftRecordRows([set({ weight: 90 }), set({ weight: 80 })], (r) => r, [set()]).slice(1);
    expect(extra).toMatchObject({ kind: "create", occurrence: 1, key: "1:1:20260101:back-squat:1~1" });
  });
});
