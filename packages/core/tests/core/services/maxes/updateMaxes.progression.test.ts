import {
  LiftingProgramSpec,
  LiftRecord,
  ProgressionSettings,
  storedLiftProgression,
  TrainingMax,
  updateMaxes,
  UpdateMaxesOptions,
} from "@src/core";

// updateMaxes moves each max by its lift's resolved progression type (#1211; proposal
// docs/proposals/2026-11-10-lift-progression-types.md, "Progression types" and "Lifts with no
// spec row"). The examples are the proposal's worked ones.

// An unregistered program, so its workouts number the stored block's days.
const BASE: UpdateMaxesOptions = {
  program: "Custom",
  liftOverrides: new Map(),
  modificationModes: new Map(),
  modificationMaxes: [],
};
const NO_SETTINGS: ProgressionSettings = { liftMeta: [], userDefault: null, defaultWeightIncrement: null, customLifts: [] };
const withSettings = (settings: Partial<ProgressionSettings> = {}, extra: Partial<UpdateMaxesOptions> = {}) => ({
  ...BASE,
  progression: { ...NO_SETTINGS, ...settings },
  ...extra,
});

const row = (lift: string, fields: Partial<LiftingProgramSpec> = {}): LiftingProgramSpec => ({
  week: 1,
  offset: 0,
  lift,
  increment: 2.5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: "",
  wtDecrementPct: 0,
  activation: "",
  ...fields,
});
const max = (lift: string, weight: number, date = "2026-01-01"): TrainingMax => ({
  lift,
  weight,
  dateUpdated: new Date(date),
});
/** One session: a set per entry of `reps`, all at `weight`. */
const session = (lift: string, workoutNum: number, date: string, weight: number, reps: number[]): LiftRecord[] =>
  reps.map((r, i) => ({
    program: "Custom",
    macrocycleNum: 1,
    workoutNum,
    date: new Date(date),
    lift,
    setNum: i + 1,
    weight,
    reps: r,
    notes: "",
  }));

describe("updateMaxes — progression type per lift (#1211)", () => {
  describe("programs progress exactly as before", () => {
    it("keeps an RPT row on the set-1 rule when the lifter's default is linear", () => {
      // RPT's rows carry amrap_gated (presets/index.ts). Set 1 hits the target, later sets don't,
      // which linear would refuse.
      const spec = [row("Bench Press", { progression: "amrap_gated", reps: 6, wtDecrementPct: 0.1 })];
      const records = session("Bench Press", 1, "2026-01-05", 200, [6, 5, 4]);
      const result = updateMaxes(
        spec,
        [max("Bench Press", 200)],
        records,
        withSettings({ userDefault: { type: "linear", repsHigh: 5 } }),
      );
      expect(result.maxes).toEqual([max("Bench Press", 202.5, "2026-01-05")]);
    });

    it("follows the row's own type without progression settings", () => {
      const spec = [row("Back Squat", { progression: "manual" })];
      const result = updateMaxes(spec, [max("Back Squat", 100)], session("Back Squat", 1, "2026-01-05", 100, [5, 5, 5]), BASE);
      expect(result.maxes).toEqual([max("Back Squat", 100)]);
    });
  });

  describe("each type moves the max by its rule", () => {
    // Squat on linear, max 100, increment 2.5, 3×5: only Monday completes every set.
    const squatWeek = [
      ...session("Squat", 1, "2026-01-05", 100, [5, 5, 5]),
      ...session("Squat", 2, "2026-01-07", 102.5, [5, 5, 3]),
      ...session("Squat", 3, "2026-01-09", 102.5, [5, 4, 3]),
    ];

    it("runs the Squat linear example to 102.5", () => {
      const result = updateMaxes([row("Squat", { progression: "linear" })], [max("Squat", 100)], squatWeek, BASE);
      expect(result.maxes).toEqual([max("Squat", 102.5, "2026-01-05")]);
      expect(result.flagged).toEqual([]);
    });

    it("moves the same week further under amrap_gated, which reads only set 1", () => {
      const result = updateMaxes([row("Squat", { progression: "amrap_gated" })], [max("Squat", 100)], squatWeek, BASE);
      expect(result.maxes).toEqual([max("Squat", 105, "2026-01-09")]);
    });

    it("holds linear when a set is missing, inside a program", () => {
      const result = updateMaxes(
        [row("Squat", { progression: "linear" })],
        [max("Squat", 100)],
        session("Squat", 1, "2026-01-05", 100, [5, 5]),
        BASE,
      );
      expect(result.maxes).toEqual([max("Squat", 100)]);
    });

    it("runs the Cable Curl double example to 32.5", () => {
      // Range 8–12 at 30: 12,11,10 doesn't complete the range; 12,12,12 does.
      const spec = [row("Cable Curl", { progression: "double", repsLow: 8, reps: 12 })];
      const records = [
        ...session("Cable Curl", 1, "2026-01-05", 30, [12, 11, 10]),
        ...session("Cable Curl", 2, "2026-01-07", 30, [12, 12, 12]),
      ];
      const result = updateMaxes(spec, [max("Cable Curl", 30)], records, BASE);
      expect(result.maxes).toEqual([max("Cable Curl", 32.5, "2026-01-07")]);
    });

    it("reads double's range from the lift when the row names no type", () => {
      // The row's reps stay the target inside a program; the lift supplies the type.
      const spec = [row("Cable Curl", { reps: 12 })];
      const records = session("Cable Curl", 1, "2026-01-05", 30, [12, 12, 11]);
      const settings = { liftMeta: [{ lift: "Cable Curl", progression: "double" as const, repsLow: 8, repsHigh: 12 }] };
      expect(updateMaxes(spec, [max("Cable Curl", 30)], records, withSettings(settings)).maxes).toEqual([
        max("Cable Curl", 30),
      ]);
    });

    it("never moves a manual max in a training week", () => {
      const result = updateMaxes(
        [row("Farmer Carry", { progression: "manual" })],
        [max("Farmer Carry", 100)],
        session("Farmer Carry", 1, "2026-01-05", 120, [20, 20, 20]),
        BASE,
      );
      expect(result.maxes).toEqual([max("Farmer Carry", 100)]);
      expect(result.flagged).toEqual([]);
    });

    it("keeps test weeks and deloads the same for every type", () => {
      const tested = updateMaxes(
        [row("Farmer Carry", { progression: "manual", weekType: "test" })],
        [max("Farmer Carry", 100)],
        session("Farmer Carry", 1, "2026-01-05", 110, [5, 5, 3]),
        BASE,
      );
      expect(tested.maxes).toEqual([max("Farmer Carry", 110, "2026-01-05")]);

      const deload = updateMaxes(
        [row("Squat", { progression: "linear", weekType: "deload" })],
        [max("Squat", 100)],
        session("Squat", 1, "2026-01-05", 100, [5, 5, 5]),
        BASE,
      );
      expect(deload.maxes).toEqual([max("Squat", 100)]);
    });

    it("flags a linear reduction instead of applying it", () => {
      const result = updateMaxes(
        [row("Squat", { progression: "linear" })],
        [max("Squat", 100)],
        session("Squat", 1, "2026-01-05", 90, [5, 5, 5]),
        BASE,
      );
      expect(result.maxes).toEqual([max("Squat", 100)]);
      expect(result.flagged).toEqual([{ lift: "Squat", currentWeight: 100, proposedWeight: 92.5 }]);
    });

    describe("percent_wave moves once per wave", () => {
      const wave = (week: number) => row("Overhead Press", { week, progression: "percent_wave" });

      it("moves once at the end of a single pass, on the spec's last week", () => {
        // Unregistered, so the program is one pass of the spec's three weeks.
        const spec = [wave(1), wave(2), wave(3)];
        const records = [
          ...session("Overhead Press", 1, "2026-01-05", 80, [5, 5, 5]),
          ...session("Overhead Press", 2, "2026-01-12", 85, [3, 3, 3]),
          ...session("Overhead Press", 3, "2026-01-19", 90, [5, 3, 1]),
        ];
        const result = updateMaxes(spec, [max("Overhead Press", 100)], records, BASE);
        expect(result.maxes).toEqual([max("Overhead Press", 102.5, "2026-01-19")]);

        // Before the last week, nothing moves; a re-run after the bump moves nothing more.
        expect(updateMaxes(spec, [max("Overhead Press", 100)], records.slice(0, 6), BASE).maxes).toEqual([
          max("Overhead Press", 100),
        ]);
        expect(updateMaxes(spec, result.maxes, records, BASE).maxes).toEqual(result.maxes);
      });

      it("moves once per pass of a program that tiles its spec's weeks twice", () => {
        // 5-3-1 runs 12 weeks, so a 6-week spec tiles twice: weeks 6 and 12 end the two waves.
        const spec = [1, 2, 3, 4, 5, 6].map(wave);
        const records = [
          ...session("Overhead Press", 3, "2026-01-19", 90, [5, 3, 1]),
          ...session("Overhead Press", 6, "2026-02-09", 90, [5, 3, 1]),
          ...session("Overhead Press", 9, "2026-03-02", 92.5, [5, 3, 1]),
          ...session("Overhead Press", 12, "2026-03-23", 92.5, [5, 3, 1]),
        ];
        const result = updateMaxes(spec, [max("Overhead Press", 100)], records, { ...BASE, program: "5-3-1" });
        expect(result.maxes).toEqual([max("Overhead Press", 105, "2026-03-23")]);

        // Only the first wave has ended: one bump.
        const firstPass = updateMaxes(spec, [max("Overhead Press", 100)], records.slice(0, 9), { ...BASE, program: "5-3-1" });
        expect(firstPass.maxes).toEqual([max("Overhead Press", 102.5, "2026-02-09")]);
      });

      it("moves once when recalculated midway through the last week and again after it", () => {
        // Two days a week, so the last week is workouts 5 and 6.
        const spec = [1, 2, 3].flatMap((week) => [0, 1].map((offset) => ({ ...wave(week), offset })));
        const monday = session("Overhead Press", 5, "2026-01-19", 90, [5, 3, 1]);
        const wednesday = session("Overhead Press", 6, "2026-01-21", 90, [5, 3, 1]);
        const midweek = updateMaxes(spec, [max("Overhead Press", 100)], monday, BASE);
        expect(midweek.maxes).toEqual([max("Overhead Press", 102.5, "2026-01-19")]);

        expect(updateMaxes(spec, midweek.maxes, [...monday, ...wednesday], BASE).maxes).toEqual(midweek.maxes);
        expect(updateMaxes(spec, [max("Overhead Press", 100)], [...monday, ...wednesday], BASE).maxes).toEqual([
          max("Overhead Press", 102.5, "2026-01-21"),
        ]);
      });

      it("ends the wave on the last week that plans the lift", () => {
        // Week 4 is a deload that leaves Overhead Press out.
        const spec = [wave(1), wave(2), wave(3), row("Squat", { week: 4, weekType: "deload" })];
        const records = session("Overhead Press", 3, "2026-01-19", 90, [5, 3, 1]);
        expect(updateMaxes(spec, [max("Overhead Press", 100)], records, BASE).maxes).toEqual([
          max("Overhead Press", 102.5, "2026-01-19"),
        ]);
      });

      it("sets the max by a test week that ends the wave, without adding the increment", () => {
        const spec = [wave(1), wave(2), { ...wave(3), weekType: "test" as const }];
        const records = session("Overhead Press", 3, "2026-01-19", 105, [3, 2, 1]);
        expect(updateMaxes(spec, [max("Overhead Press", 100)], records, BASE).maxes).toEqual([
          max("Overhead Press", 105, "2026-01-19"),
        ]);
      });
    });
  });

  it("uses the row's increment in a program and the lift's own off it", () => {
    const settings = { liftMeta: [{ lift: "Cable Curl", progression: "amrap_gated" as const, progressionIncrement: 5, repsHigh: 10 }] };
    const records = session("Cable Curl", 1, "2026-01-05", 30, [10, 10, 10]);

    const inProgram = updateMaxes([row("Cable Curl", { reps: 10, increment: 2.5 })], [max("Cable Curl", 30)], records, withSettings(settings));
    expect(inProgram.maxes).toEqual([max("Cable Curl", 32.5, "2026-01-05")]);

    const offProgram = updateMaxes([row("Bench Press")], [max("Cable Curl", 30)], records, withSettings(settings));
    expect(offProgram.maxes).toEqual([max("Cable Curl", 35, "2026-01-05")]);
    expect(offProgram.skipped).toEqual([]);
  });

  describe("an off-program lift progresses by its own target", () => {
    const spec = [row("Bench Press")];

    it("aims linear at the lift's repsHigh", () => {
      const settings = { liftMeta: [{ lift: "Hammer Curl", progression: "linear" as const, repsHigh: 10 }], defaultWeightIncrement: 1.25 };
      const hit = updateMaxes(spec, [max("Hammer Curl", 40)], session("Hammer Curl", 1, "2026-01-05", 40, [10, 10]), withSettings(settings));
      expect(hit.maxes).toEqual([max("Hammer Curl", 41.25, "2026-01-05")]);

      const missed = updateMaxes(spec, [max("Hammer Curl", 40)], session("Hammer Curl", 1, "2026-01-05", 40, [10, 9]), withSettings(settings));
      expect(missed.maxes).toEqual([max("Hammer Curl", 40)]);
    });

    it("falls back to the catalog's default, and to the lifter's default over it", () => {
      // Cable Curl's catalog default is double 8–12.
      const records = session("Cable Curl", 1, "2026-01-05", 30, [12, 12, 12]);
      expect(updateMaxes(spec, [max("Cable Curl", 30)], records, withSettings()).maxes).toEqual([
        max("Cable Curl", 31.25, "2026-01-05"),
      ]);
      const userDefault = { type: "manual" as const };
      expect(updateMaxes(spec, [max("Cable Curl", 30)], records, withSettings({ userDefault })).maxes).toEqual([
        max("Cable Curl", 30),
      ]);
      // A custom lift named like a catalog one means the custom lift, which has no catalog default.
      const custom = updateMaxes(spec, [max("Cable Curl", 30)], records, withSettings({ customLifts: [{ name: "Cable Curl" }] }));
      expect(custom.skipped).toEqual([{ lift: "Cable Curl", reason: "no-target-reps" }]);
    });

    it("bumps percent_wave once when the macrocycle ends, and not before", () => {
      const settings = { liftMeta: [{ lift: "Hammer Curl", progression: "percent_wave" as const, progressionIncrement: 2.5 }] };
      const records = [
        ...session("Hammer Curl", 1, "2026-01-05", 40, [8, 8]),
        ...session("Hammer Curl", 2, "2026-01-12", 40, [8, 8]),
      ];
      expect(updateMaxes(spec, [max("Hammer Curl", 40)], records, withSettings(settings)).maxes).toEqual([
        max("Hammer Curl", 40),
      ]);
      const ended = updateMaxes(spec, [max("Hammer Curl", 40)], records, withSettings(settings, { endOfMacrocycle: true }));
      expect(ended.maxes).toEqual([max("Hammer Curl", 42.5, "2026-01-12")]);
    });

    it("reports a lift with no reps resolved, and moves nothing", () => {
      // A custom lift has no catalog default; the lifter's default names a type but no target.
      const records = session("Landmine Press", 1, "2026-01-05", 50, [10, 10]);
      const result = updateMaxes(
        spec,
        [max("Landmine Press", 50)],
        records,
        withSettings({ userDefault: { type: "linear" } }),
      );
      expect(result.maxes).toEqual([max("Landmine Press", 50)]);
      expect(result.skipped).toEqual([{ lift: "Landmine Press", reason: "no-target-reps" }]);
    });

    it("reads a stored range whose bottom is above its top as unset", () => {
      const crossed = { lift: "Landmine Press", progression: "linear" as const, repsLow: 12, repsHigh: 8 };
      expect(storedLiftProgression(crossed)).toEqual({ ...crossed, repsLow: null, repsHigh: null });

      const result = updateMaxes(
        spec,
        [max("Landmine Press", 50)],
        session("Landmine Press", 1, "2026-01-05", 50, [10, 10]),
        withSettings({ liftMeta: [crossed] }),
      );
      expect(result.skipped).toEqual([{ lift: "Landmine Press", reason: "no-target-reps" }]);
    });
  });

  it("moves an own max by its lift's progression", () => {
    // Linear holds an own max when one of the session's sets misses (#1153 keeps the routing).
    const spec = [row("Cable Curl", { progression: "linear", reps: 10 })];
    const options = {
      ...BASE,
      modificationModes: new Map([["wide-grip", "own" as const]]),
      modificationMaxes: [{ modificationId: "wide-grip", weight: 25, dateUpdated: new Date("2026-01-01") }],
    };
    const own = (reps: number[]) =>
      session("Cable Curl", 1, "2026-01-05", 25, reps).map((r) => ({ ...r, modifications: ["wide-grip"] }));

    expect(updateMaxes(spec, [max("Cable Curl", 30)], own([10, 10, 9]), options).modificationMaxes).toEqual(
      options.modificationMaxes,
    );
    const hit = updateMaxes(spec, [max("Cable Curl", 30)], own([10, 10, 10]), options);
    expect(hit.modificationMaxes).toEqual([{ modificationId: "wide-grip", weight: 27.5, dateUpdated: new Date("2026-01-05") }]);
    expect(hit.maxes).toEqual([max("Cable Curl", 30)]);
  });
});
