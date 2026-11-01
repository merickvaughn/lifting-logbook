"use strict";
/**
 * Plain-JS child-process worker for distributeWorkouts.timezone.test.ts
 * (issue #1031). The test spawns this script with TZ set at launch, because a
 * mid-process `process.env.TZ` change is ignored inside a Jest worker on this
 * repo's Windows setup (see aheadOfUtcChild.js for the full story).
 *
 * The start date is built the way the API builds a macrocycle date:
 * `new Date("YYYY-MM-DD")`, which is UTC midnight. Each scheduled date is
 * reported as an ISO string, so the test sees both the calendar day and the
 * time of day.
 *
 * Deliberately NOT named `*.test.js`, so Jest never runs it on its own.
 */
const path = require("path");
// Registers the transpile-on-require hook and `@src/core` alias.
const { CORE_SRC } = require("./registerTsRequire");

const { distributeWorkouts } = require(
  path.join(CORE_SRC, "services", "workout", "distributeWorkouts.ts"),
);

// 0 = Monday … 6 = Sunday (DAY_INDEX).
const MON_WED_FRI = { type: "fixed", days: [0, 2, 4] };
const iso = (weeks) => weeks.flatMap((w) => w.workouts).map((d) => d.toISOString());

process.stdout.write(
  JSON.stringify({
    // Positive west of UTC, negative east of it: lets the test confirm the
    // child really ran in the zone it asked for.
    timezoneOffsetMinutes: new Date("2026-05-18").getTimezoneOffset(),
    // 2026-05-18 is a Monday.
    mondayStart: iso(distributeWorkouts(3, MON_WED_FRI, new Date("2026-05-18"))),
    // 2026-05-20 is a Wednesday; the first week still aligns to Monday 05-18.
    wednesdayStart: iso(distributeWorkouts(3, MON_WED_FRI, new Date("2026-05-20"))),
    // US daylight saving starts on 2026-03-08, inside the second week.
    acrossDstChange: iso(distributeWorkouts(6, MON_WED_FRI, new Date("2026-03-02"))),
  }),
);
