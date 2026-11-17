"use strict";
/**
 * Child-process worker for dateParsing.timeStamped.test.ts (#1316). It runs
 * parseDateStringUTC under whatever TZ the parent launched it with, because
 * Jest ignores a `process.env.TZ` change made mid-process (see CLAUDE.md and
 * aheadOfUtcChild.js). Not named `*.test.js`, so Jest never runs it directly.
 */
const path = require("path");
const { CORE_SRC } = require("./registerTsRequire");

const { parseDateStringUTC } = require(path.join(CORE_SRC, "utils", "jsUtil.ts"));

process.stdout.write(
  JSON.stringify({
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    epochArtefact: parseDateStringUTC("12/31/1969 19:00:00").toISOString(),
    morningSession: parseDateStringUTC("11/9/2026 07:30:00").toISOString(),
  }),
);
