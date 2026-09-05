import {
  mapTrainingMaxes,
  TRAINING_MAX_HEADER_MAP,
  TrainingMax,
} from "@src/core";

describe("mapTrainingMaxes", () => {
  it("should map TrainingMax[] to 2D array with all columns and headers", () => {
    const headers = Object.keys(TRAINING_MAX_HEADER_MAP);
    const maxes: TrainingMax[] = [
      {
        dateUpdated: new Date("2026-01-01"),
        lift: "Squat",
        weight: 200,
      },
      {
        dateUpdated: new Date("2026-01-02"),
        lift: "Bench",
        weight: 150,
      },
    ];
    const result = mapTrainingMaxes(maxes);
    expect(result[0]).toEqual(headers);
    expect(result[1]).toEqual([new Date("2026-01-01"), "Squat", 200]);
    expect(result[2]).toEqual([new Date("2026-01-02"), "Bench", 150]);
  });
});
