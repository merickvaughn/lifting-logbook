"use strict";
/**
 * Plain-JS child-process worker for getNextDate.timezone.test.ts (issue
 * #1102). The test spawns this script with TZ set at launch, because a
 * mid-process `process.env.TZ` change is ignored inside a Jest worker on this
 * repo's Windows setup (see aheadOfUtcChild.js for the full story).
 *
 * Dates are built the way the API builds a macrocycle date:
 * `new Date("YYYY-MM-DD")`, which is UTC midnight.
 *
 * Deliberately NOT named `*.test.js`, so Jest never runs it on its own.
 */
const path = require("path");
// Registers the transpile-on-require hook and `@src/core` alias.
const { CORE_SRC } = require("./registerTsRequire");

const { getNextDate } = require(path.join(CORE_SRC, "utils", "jsUtil.ts"));
const { updateMacrocycle } = require(
  path.join(CORE_SRC, "services", "dashboard", "updateMacrocycle.ts"),
);

const MONDAY = 1;
// 2026-05-18 is a Monday.
const prevMonday = new Date("2026-05-18");
const next = updateMacrocycle(
  {
    program: "RPT",
    macrocycleUnit: "Week",
    macrocycleNum: 1,
    macrocycleDate: prevMonday,
    sheetName: "RPT_Cycle_1_20260518",
    macrocycleStartWeekday: "Monday",
  },
  { today: new Date("2026-06-17") },
);

process.stdout.write(
  JSON.stringify({
    // Positive west of UTC, negative east of it: lets the test confirm the
    // child really ran in the zone it asked for.
    timezoneOffsetMinutes: prevMonday.getTimezoneOffset(),
    // Today (Monday 2026-06-15) is the target weekday.
    todayIsTarget: getNextDate(prevMonday, MONDAY, new Date("2026-06-15")).toISOString(),
    // Today is Wednesday 2026-06-17; the most recent Monday is 2026-06-15.
    mostRecentTarget: getNextDate(prevMonday, MONDAY, new Date("2026-06-17")).toISOString(),
    // Today is too soon; the next Monday at least 7 days later is 2026-05-25.
    nextTarget: getNextDate(prevMonday, MONDAY, new Date("2026-05-20")).toISOString(),
    // No targetWeekday: defaults to prevDate's own (UTC) weekday.
    defaultWeekday: getNextDate(prevMonday, undefined, new Date("2026-05-20")).toISOString(),
    // updateMacrocycle with no explicit date.
    updateMacrocycle: {
      macrocycleDate: next.macrocycleDate.toISOString(),
      sheetName: next.sheetName,
    },
  }),
);
