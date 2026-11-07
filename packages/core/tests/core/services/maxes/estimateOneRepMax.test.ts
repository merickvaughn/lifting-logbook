import { estimateOneRepMax, estimateRepMax } from "@src/core";

describe("estimateRepMax", () => {
  // 225 × (37 − reps) / 36, floored to the nearest 2.5.
  it.each([
    [1, 225],
    [2, 217.5], // 218.75
    [3, 212.5],
    [4, 205], // 206.25
    [5, 200],
    [6, 192.5], // 193.75
    [7, 187.5],
    [8, 180], // 181.25
    [9, 175],
    [10, 167.5], // 168.75
  ])("inverts estimateOneRepMax: a 225 one-rep max gives %i reps at %d", (reps, weight) => {
    expect(estimateRepMax(225, 1, reps)).toBe(weight);
  });

  it("matches estimateOneRepMax when the target is one rep", () => {
    for (let weight = 2.5; weight <= 500; weight += 2.5) {
      for (let reps = 1; reps <= 36; reps++) {
        expect(estimateRepMax(weight, reps, 1)).toBe(estimateOneRepMax(weight, reps));
      }
    }
  });

  it("gives the set back at its own rep count, for any loadable weight", () => {
    for (let weight = 2.5; weight <= 500; weight += 2.5) {
      for (let reps = 1; reps <= 36; reps++) {
        expect(estimateRepMax(weight, reps, reps)).toBe(weight);
      }
    }
  });

  it("does not floor twice: 210 × 3 stays 210 for 3 reps", () => {
    expect(estimateOneRepMax(210, 3)).toBe(220);
    expect(estimateRepMax(220, 1, 3)).toBe(207.5);
    expect(estimateRepMax(210, 3, 3)).toBe(210);
  });

  it("returns 0 for non-positive input and at the formula asymptote", () => {
    expect(estimateRepMax(0, 5, 3)).toBe(0);
    expect(estimateRepMax(-10, 5, 3)).toBe(0);
    expect(estimateRepMax(200, 0, 3)).toBe(0);
    expect(estimateRepMax(200, -1, 3)).toBe(0);
    expect(estimateRepMax(200, 5, 0)).toBe(0);
    expect(estimateRepMax(200, 37, 3)).toBe(0);
    expect(estimateRepMax(200, 5, 37)).toBe(0);
  });
});

describe("estimateOneRepMax", () => {
  it("floors the weight to the nearest 2.5 for a single rep", () => {
    expect(estimateOneRepMax(225, 1)).toBe(225);
    expect(estimateOneRepMax(225.4, 1)).toBe(225);
    // Distinguishes floor-to-2.5 from round-to-nearest: 203 rounds to 203 but
    // floors to 202.5.
    expect(estimateOneRepMax(203, 1)).toBe(202.5);
  });

  it("estimates a higher 1RM for multi-rep sets, floored to the nearest 2.5", () => {
    // 200 × 5 → 200 × 36 / 32 = 225 (already an exact multiple of 2.5)
    expect(estimateOneRepMax(200, 5)).toBe(225);
    // 210 × 3 → 210 × 36 / 34 = 222.35... rounds to 222 but floors to 220.
    expect(estimateOneRepMax(210, 3)).toBe(220);
  });

  it("returns 0 for non-positive weight or reps", () => {
    expect(estimateOneRepMax(0, 5)).toBe(0);
    expect(estimateOneRepMax(200, 0)).toBe(0);
    expect(estimateOneRepMax(-10, 5)).toBe(0);
    expect(estimateOneRepMax(200, -3)).toBe(0);
  });

  it("returns 0 at and beyond the formula asymptote (reps ≥ 37)", () => {
    expect(estimateOneRepMax(200, 37)).toBe(0);
    expect(estimateOneRepMax(200, 40)).toBe(0);
  });
});
