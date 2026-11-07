import {
  ESTIMATE_FLOOR_INCREMENT,
  MAX_ESTIMATE_REPS,
  estimateOneRepMax,
  estimateRepMax,
} from "@src/core";

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

  it.each([1.25, 2.5, 5, 10])(
    "gives the set back at its own rep count, for a weight on the %d increment",
    (increment) => {
      for (let weight = increment; weight <= 500; weight += increment) {
        for (let reps = 1; reps <= MAX_ESTIMATE_REPS; reps++) {
          expect(estimateRepMax(weight, reps, reps, increment)).toBe(weight);
        }
      }
    },
  );

  it("floors a set off the increment, even at its own rep count", () => {
    expect(estimateRepMax(211.25, 3, 3)).toBe(210);
    expect(estimateRepMax(211.25, 3, 3, 1.25)).toBe(211.25);
    expect(estimateRepMax(205, 3, 3, 10)).toBe(200);
  });

  it.each([
    [1.25, 218.75],
    [2.5, 217.5],
    [5, 215],
    [10, 210],
  ])("floors to an increment of %d", (increment, weight) => {
    expect(estimateRepMax(225, 1, 2, increment)).toBe(weight);
  });

  it("floors to 2.5 unless told otherwise", () => {
    expect(ESTIMATE_FLOOR_INCREMENT).toBe(2.5);
    expect(estimateRepMax(225, 1, 2)).toBe(estimateRepMax(225, 1, 2, 2.5));
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
    expect(estimateRepMax(200, MAX_ESTIMATE_REPS + 1, 3)).toBe(0);
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

  it("floors to the given increment", () => {
    expect(estimateOneRepMax(210, 3, 1.25)).toBe(221.25);
    expect(estimateOneRepMax(210, 3, 5)).toBe(220);
    expect(estimateOneRepMax(200, 5, 10)).toBe(220);
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
