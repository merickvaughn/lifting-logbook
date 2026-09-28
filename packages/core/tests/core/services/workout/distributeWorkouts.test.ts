import { DAY_INDEX, UserWorkoutSchedule } from "@lifting-logbook/types";
import {
  distributeWorkouts,
  getScheduleWorkoutsPerWeek,
} from "@src/core/services/workout/distributeWorkouts";

// All test dates use local time to match addDaysLocal in the implementation.
// JS Date months are 0-indexed: 4 = May. 2026-05-18 is a Monday; 2026-05-20 is a Wednesday.
const MAY = 4;
const MON_2026_05_18 = new Date(2026, MAY, 18);
const WED_2026_05_20 = new Date(2026, MAY, 20);

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("distributeWorkouts", () => {
  it("places 12 fixed Mon/Wed/Fri workouts across exactly 4 weeks", () => {
    const schedule: UserWorkoutSchedule = {
      type: "fixed",
      days: [DAY_INDEX.MON, DAY_INDEX.WED, DAY_INDEX.FRI],
    };
    const result = distributeWorkouts(12, schedule, MON_2026_05_18);

    expect(result).toHaveLength(4);
    expect(result.map((w) => w.workouts.length)).toEqual([3, 3, 3, 3]);
    expect(result[0]!.workouts.map(ymd)).toEqual([
      "2026-05-18", // Mon
      "2026-05-20", // Wed
      "2026-05-22", // Fri
    ]);
    expect(result[3]!.workouts.map(ymd)).toEqual([
      "2026-06-08",
      "2026-06-10",
      "2026-06-12",
    ]);
  });

  it("trims the final week when cycleWorkouts is not a multiple of the weekly count", () => {
    const schedule: UserWorkoutSchedule = {
      type: "fixed",
      days: [DAY_INDEX.MON, DAY_INDEX.WED, DAY_INDEX.FRI],
    };
    const result = distributeWorkouts(10, schedule, MON_2026_05_18);

    expect(result).toHaveLength(4);
    expect(result[3]!.workouts.map(ymd)).toEqual(["2026-06-08"]);
  });

  it("rotates through week patterns for a rotating schedule", () => {
    const schedule: UserWorkoutSchedule = {
      type: "rotating",
      weeks: [
        [DAY_INDEX.MON, DAY_INDEX.WED, DAY_INDEX.FRI, DAY_INDEX.SAT], // week A: 4
        [DAY_INDEX.TUE, DAY_INDEX.THU, DAY_INDEX.SAT], // week B: 3
      ],
    };
    const result = distributeWorkouts(14, schedule, MON_2026_05_18);

    // 4 + 3 + 4 + 3 = 14 → 4 weeks
    expect(result.map((w) => w.workouts.length)).toEqual([4, 3, 4, 3]);
    expect(result[1]!.workouts.map(ymd)).toEqual([
      "2026-05-26", // Tue
      "2026-05-28", // Thu
      "2026-05-30", // Sat
    ]);
    expect(result[2]!.workouts.map(ymd)).toEqual([
      "2026-06-01", // Mon (week A again)
      "2026-06-03",
      "2026-06-05",
      "2026-06-06",
    ]);
  });

  it("dates each week's days in weekday order, whatever order the schedule lists them (issue #1023)", () => {
    // The settings validator accepts days in any order. Scheduled workouts are
    // numbered by position, so a week listed as [Fri, Mon, Wed] must still come
    // out Mon, Wed, Fri, or workout 2 would fall before workout 1.
    const fixed = distributeWorkouts(
      3,
      { type: "fixed", days: [DAY_INDEX.FRI, DAY_INDEX.MON, DAY_INDEX.WED] },
      MON_2026_05_18,
    );
    expect(fixed[0]?.workouts.map(ymd)).toEqual(["2026-05-18", "2026-05-20", "2026-05-22"]);

    const rotating = distributeWorkouts(
      4,
      { type: "rotating", weeks: [[DAY_INDEX.THU, DAY_INDEX.TUE], [DAY_INDEX.SAT, DAY_INDEX.MON]] },
      MON_2026_05_18,
    );
    expect(rotating.flatMap((w) => w.workouts).map(ymd)).toEqual([
      "2026-05-19", // Tue
      "2026-05-21", // Thu
      "2026-05-25", // Mon
      "2026-05-30", // Sat
    ]);
  });

  it("does not reorder the schedule it was given", () => {
    const days = [DAY_INDEX.FRI, DAY_INDEX.MON];
    distributeWorkouts(2, { type: "fixed", days }, MON_2026_05_18);
    expect(days).toEqual([DAY_INDEX.FRI, DAY_INDEX.MON]);
  });

  it("aligns the first week to the Monday of the start date's week", () => {
    // Wednesday start — first week's Mon and earlier days are still emitted by design.
    const schedule: UserWorkoutSchedule = {
      type: "fixed",
      days: [DAY_INDEX.MON, DAY_INDEX.WED, DAY_INDEX.FRI],
    };
    const result = distributeWorkouts(3, schedule, WED_2026_05_20);

    expect(result).toHaveLength(1);
    expect(result[0]!.workouts.map(ymd)).toEqual([
      "2026-05-18", // Mon of the start-date week
      "2026-05-20",
      "2026-05-22",
    ]);
  });

  it("handles a single workout", () => {
    const schedule: UserWorkoutSchedule = {
      type: "fixed",
      days: [DAY_INDEX.WED],
    };
    const result = distributeWorkouts(1, schedule, MON_2026_05_18);

    expect(result).toEqual([
      { week: 1, workouts: [new Date(2026, MAY, 20)] },
    ]);
  });

  it("returns an empty array when fixed schedule has no days (no infinite loop)", () => {
    const schedule = { type: "fixed", days: [] } as unknown as UserWorkoutSchedule;
    expect(distributeWorkouts(5, schedule, MON_2026_05_18)).toEqual([]);
  });

  it("returns an empty array when rotating schedule has only empty weeks", () => {
    const schedule = {
      type: "rotating",
      weeks: [[], []],
    } as unknown as UserWorkoutSchedule;
    expect(distributeWorkouts(5, schedule, MON_2026_05_18)).toEqual([]);
  });

  it("returns an empty array when cycleWorkouts is zero", () => {
    const schedule: UserWorkoutSchedule = {
      type: "fixed",
      days: [DAY_INDEX.MON],
    };
    expect(distributeWorkouts(0, schedule, MON_2026_05_18)).toEqual([]);
  });

  it("throws when cycleWorkouts is negative", () => {
    const schedule: UserWorkoutSchedule = {
      type: "fixed",
      days: [DAY_INDEX.MON],
    };
    expect(() => distributeWorkouts(-1, schedule, MON_2026_05_18)).toThrow(
      /non-negative/,
    );
  });
});

describe("getScheduleWorkoutsPerWeek", () => {
  it("returns the length of days for fixed schedules", () => {
    expect(
      getScheduleWorkoutsPerWeek({
        type: "fixed",
        days: [DAY_INDEX.MON, DAY_INDEX.WED, DAY_INDEX.FRI],
      }),
    ).toBe(3);
  });

  it("returns 0 for a fixed schedule with no days", () => {
    expect(
      getScheduleWorkoutsPerWeek({
        type: "fixed",
        days: [],
      } as unknown as UserWorkoutSchedule),
    ).toBe(0);
  });

  it("returns the rounded average across week patterns for rotating", () => {
    // (4 + 3) / 2 = 3.5 → rounds to 4
    expect(
      getScheduleWorkoutsPerWeek({
        type: "rotating",
        weeks: [
          [DAY_INDEX.MON, DAY_INDEX.WED, DAY_INDEX.FRI, DAY_INDEX.SAT],
          [DAY_INDEX.TUE, DAY_INDEX.THU, DAY_INDEX.SAT],
        ],
      }),
    ).toBe(4);
  });

  it("returns 0 for a rotating schedule with no weeks", () => {
    expect(
      getScheduleWorkoutsPerWeek({
        type: "rotating",
        weeks: [],
      } as unknown as UserWorkoutSchedule),
    ).toBe(0);
  });
});
