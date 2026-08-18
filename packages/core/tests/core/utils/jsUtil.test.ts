import {
  addDaysUTC,
  formatDateYYYYMMDD,
  getNextDate,
  type LiftingProgramSpec,
  parseYYYYMMDD,
  toUTCMidnight,
  weekTypeForDate,
} from "@src/core";

describe("jsUtil", () => {
  describe("formatDateYYYYMMDD", () => {
    it("formats Date object to YYYY-MM-DD (UTC)", () => {
      const date = new Date(2026, 0, 1); // Jan 1, 2026 UTC
      expect(formatDateYYYYMMDD(date)).toBe("20260101");
    });
    it("formats MM/DD/YYYY string to YYYY-MM-DD (UTC)", () => {
      expect(formatDateYYYYMMDD("1/1/2026")).toBe("20260101");
    });
    it("formats YYYY-MM-DD string to YYYY-MM-DD (UTC)", () => {
      expect(formatDateYYYYMMDD("2026-01-01")).toBe("20260101");
    });
    it("handles already formatted string", () => {
      expect(formatDateYYYYMMDD("2026-12-31")).toBe("20261231");
    });

    // Audit (#354): pin current behavior of the `return String(date)` fallback
    // and the silent NaN path when delimiter-split produces 3 non-numeric parts.
    // Both currently fail silently rather than throwing; locking the behavior
    // here makes any future change (e.g., throwing on garbage input) deliberate.
    it("falls back to String(date) for strings whose split yields fewer than 3 parts", () => {
      expect(formatDateYYYYMMDD("2026/01")).toBe("2026/01");
      expect(formatDateYYYYMMDD("2026")).toBe("2026");
    });

    it("returns 'NaNNaNNaN' when a 3-part split contains non-numeric tokens (current behavior; not a contract)", () => {
      expect(formatDateYYYYMMDD("not-a-date")).toBe("NaNNaNNaN");
    });
  });

  describe("parseYYYYMMDD", () => {
    it("round-trips formatDateYYYYMMDD's output", () => {
      const date = new Date(2026, 7, 17); // Aug 17, 2026
      const formatted = formatDateYYYYMMDD(date);
      const parsed = parseYYYYMMDD(formatted);
      expect(parsed).not.toBeNull();
      expect(formatDateYYYYMMDD(parsed!)).toBe(formatted);
    });

    it("parses a compact digit string to UTC midnight", () => {
      const parsed = parseYYYYMMDD("20260817");
      expect(parsed?.getUTCFullYear()).toBe(2026);
      expect(parsed?.getUTCMonth()).toBe(7); // 0-indexed August
      expect(parsed?.getUTCDate()).toBe(17);
      expect(parsed?.getUTCHours()).toBe(0);
    });

    it("returns null for a delimited date string", () => {
      expect(parseYYYYMMDD("2026-01-01")).toBeNull();
    });

    it("returns null for non-numeric input", () => {
      expect(parseYYYYMMDD("abc")).toBeNull();
    });

    it("returns null for input that isn't exactly 8 digits", () => {
      expect(parseYYYYMMDD("202611")).toBeNull();
      expect(parseYYYYMMDD("202608170")).toBeNull();
    });
  });

  describe("toUTCMidnight", () => {
    it("truncates a mid-day timestamp to UTC midnight of the same day", () => {
      const date = new Date(Date.UTC(2026, 7, 17, 15, 30, 45));
      const truncated = toUTCMidnight(date);
      expect(truncated.getUTCFullYear()).toBe(2026);
      expect(truncated.getUTCMonth()).toBe(7);
      expect(truncated.getUTCDate()).toBe(17);
      expect(truncated.getUTCHours()).toBe(0);
      expect(truncated.getUTCMinutes()).toBe(0);
      expect(truncated.getUTCSeconds()).toBe(0);
    });

    it("is a no-op on an already-UTC-midnight value", () => {
      const date = new Date(Date.UTC(2026, 7, 17));
      expect(toUTCMidnight(date).getTime()).toBe(date.getTime());
    });
  });

  describe("weekTypeForDate", () => {
    // Audit (#354): weekTypeForDate had no tests at all. These cover the
    // matching-week path AND the `?? 'training'` neutral-return fallback
    // so a regression in either branch is detectable.
    const spec: LiftingProgramSpec[] = [
      {
        week: 1,
        offset: 0,
        lift: "Bench",
        increment: 0,
        order: 0,
        sets: 0,
        reps: 0,
        amrap: false,
        warmUpPct: "",
        wtDecrementPct: 0,
        activation: "",
        weekType: "training",
      },
      {
        week: 2,
        offset: 0,
        lift: "Bench",
        increment: 0,
        order: 0,
        sets: 0,
        reps: 0,
        amrap: false,
        warmUpPct: "",
        wtDecrementPct: 0,
        activation: "",
        weekType: "test",
      },
    ];

    it("returns the matching week's weekType when today is within the spec", () => {
      const cycleStart = new Date(2026, 0, 5);
      const today = new Date(2026, 0, 12); // week 2 (7 days later)
      expect(weekTypeForDate(cycleStart, spec, today)).toBe("test");
    });

    it("clamps to the max week in the spec when today is past the spec's range", () => {
      const cycleStart = new Date(2026, 0, 5);
      // In-range week 2 returns "test" (baseline); past-range should also return
      // "test" via clamp-to-max, not the "training" fallback. Asserting both
      // pins the clamp specifically rather than incidentally matching the max.
      expect(weekTypeForDate(cycleStart, spec, new Date(2026, 0, 12))).toBe(
        "test",
      );
      const today = new Date(2026, 1, 28); // far past week 2
      expect(weekTypeForDate(cycleStart, spec, today)).toBe("test");
    });

    it("returns 'training' fallback when the matched week has no weekType set", () => {
      // Destructure to omit weekType — TS2375 under exactOptionalPropertyTypes
      // rules out the simpler `{ ...spec[0]!, weekType: undefined }`.
      const { weekType: _omit, ...rest } = spec[0]!;
      void _omit;
      const partialSpec: LiftingProgramSpec[] = [rest];
      const cycleStart = new Date(2026, 0, 5);
      const today = new Date(2026, 0, 5);
      expect(weekTypeForDate(cycleStart, partialSpec, today)).toBe("training");
    });

    it("returns 'training' fallback when no spec entry matches the computed week", () => {
      const cycleStart = new Date(2026, 0, 5);
      const today = new Date(2026, 0, 5);
      expect(weekTypeForDate(cycleStart, [], today)).toBe("training");
    });
  });

  describe("addDaysUTC", () => {
    it("adds days to a date in UTC", () => {
      const date = new Date(2026, 0, 1);
      const result = addDaysUTC(date, 5);
      expect(formatDateYYYYMMDD(result)).toBe("20260106");
    });
    it("handles negative days", () => {
      const date = new Date(2026, 0, 10);
      const result = addDaysUTC(date, -3);
      expect(formatDateYYYYMMDD(result)).toBe("20260107");
    });
    it("does not mutate the original date", () => {
      const date = new Date(2026, 0, 1);
      addDaysUTC(date, 10);
      expect(formatDateYYYYMMDD(date)).toBe("20260101");
    });
  });

  describe("getNextDate", () => {
    it("returns the next occurrence of prevDate's weekday at least 7 days after prevDate if no targetWeekday is given", () => {
      const prevDate = new Date(2026, 0, 1); // Thursday, Jan 1, 2026
      // Next Thursday after Jan 1, 2026 is Jan 8, 2026, but must be at least 7 days after prevDate, so Jan 8, 2026
      const result = getNextDate(prevDate, undefined, new Date(2026, 0, 2));
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(8);
    });

    it("returns correct date when prevDate is on Sunday and no targetWeekday is given", () => {
      const prevDate = new Date(2026, 0, 4); // Sunday, Jan 4, 2026
      // Next Sunday at least 7 days after is Jan 11, 2026
      const result = getNextDate(prevDate, undefined, new Date(2026, 0, 5));
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(11);
    });

    it("returns correct date when prevDate is on Saturday and no targetWeekday is given", () => {
      const prevDate = new Date(2026, 0, 3); // Saturday, Jan 3, 2026
      // Next Saturday at least 7 days after is Jan 10, 2026
      const result = getNextDate(prevDate, undefined, new Date(2026, 0, 4));
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(10);
    });

    it("returns today if today matches targetWeekday and is at least 7 days after prevDate", () => {
      const prevDate = new Date(2026, 0, 1); // Thursday
      const today = new Date(2026, 0, 8); // Next Thursday
      const result = getNextDate(prevDate, 4, today); // 4 = Thursday
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(8);
    });

    it("returns most recent occurrence of targetWeekday if at least 7 days after prevDate", () => {
      const prevDate = new Date(2026, 0, 1); // Thursday
      const today = new Date(2026, 0, 10); // Saturday
      // Most recent Thursday is Jan 8, 2026
      const result = getNextDate(prevDate, 4, today); // 4 = Thursday
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(8);
    });

    it("returns the next valid occurrence at least 7 days after prevDate if today and most recent are too soon", () => {
      const prevDate = new Date(2026, 0, 1); // Thursday
      const today = new Date(2026, 0, 2); // Friday
      // Next Thursday after Jan 1, 2026 is Jan 8, 2026
      const result = getNextDate(prevDate, 4, today); // 4 = Thursday
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(8);
    });

    it("handles week wrap-around for targetWeekday before prevDate's weekday", () => {
      const prevDate = new Date(2026, 0, 2); // Friday
      // Next Monday after Jan 2, 2026 is Jan 5, 2026, but must be at least 7 days after prevDate, so Jan 12, 2026
      const result = getNextDate(prevDate, 1, new Date(2026, 0, 3)); // 1 = Monday
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(12);
    });

    it("returns correct date when prevDate is already on the targetWeekday", () => {
      const prevDate = new Date(2026, 0, 5); // Monday
      // Next Monday at least 7 days after is Jan 12, 2026
      const result = getNextDate(prevDate, 1, new Date(2026, 0, 6)); // 1 = Monday
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(12);
    });

    it("returns correct date when prevDate is far in the past", () => {
      const prevDate = new Date(2020, 0, 1); // Wednesday
      const today = new Date(2026, 0, 8); // Thursday
      // Most recent Thursday is Jan 8, 2026
      const result = getNextDate(prevDate, 4, today);
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(8);
    });

    it("returns correct date when prevDate is on leap year day", () => {
      const prevDate = new Date(2024, 1, 29); // Thursday, Feb 29, 2024 (leap year
      // Next Thursday at least 7 days after is Mar 7, 2024
      const result = getNextDate(prevDate, 4, new Date(2024, 2, 1));
      expect(result.getUTCFullYear()).toBe(2024);
      expect(result.getUTCMonth()).toBe(2);
      expect(result.getUTCDate()).toBe(7);
    });

    it("returns correct date when prevDate is at end of year", () => {
      const prevDate = new Date(2025, 11, 31); // Wednesday, Dec 31, 2025
      // Next Wednesday at least 7 days after is Jan 7, 2026
      const result = getNextDate(prevDate, undefined, new Date(2026, 0, 1));
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(0);
      expect(result.getUTCDate()).toBe(7);
    });
  });
});
