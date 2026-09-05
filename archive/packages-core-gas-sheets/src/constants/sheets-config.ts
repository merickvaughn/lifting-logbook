// Google-Sheets-era dashboard keys and sheet header constants.
//
// Moved out of `packages/core/src/constants/config.ts` together with their only
// consumers (the grid builders, sheet mappers and dashboard parser in this
// archive) — issue #979. `LiftRecordRequiredKeys` came from
// `packages/core/src/models/LiftRecord.ts`, where `extractLiftRecords` was its
// only reader.

import type { LiftRecord } from '../../../../packages/core/src/models/LiftRecord';

// Dashboard CSV/Sheet property keys
export const PROGRAM_KEY = "Program";
export const CYCLE_UNIT_KEY = "Cycle Unit";
export const CYCLE_NUM_KEY = "Cycle #";
export const CYCLE_DATE_KEY = "Cycle Date";
export const SHEET_NAME_KEY = "Sheet Name";
export const CYCLE_START_WEEKDAY_KEY = "Start Weekday";

// Constants for headers and formatting
export const CORE_LIFT_HEADER = "Core Lift";
export const SPEC_WEIGHT_HEADER = "TM";
export const LIFT_DATE_HEADER = "Lift Date";
export const LIFT_WEIGHT_HEADER = "Weight";
export const DATE_HEADER = "Date";
export const LIFT_HEADER = "Lift";
export const SET_HEADER = "Set";
export const REPS_HEADER = "Reps";
export const NOTES_HEADER = "Notes";
export const WORKOUT_SHEET_HEADERS = ["Program", "", "Cycle", "", "Weight", ""];
export const LIFT_SPEC_HEADERS = [
  CORE_LIFT_HEADER,
  "Scheme",
  "Inc. Amt.",
  SPEC_WEIGHT_HEADER,
  LIFT_DATE_HEADER,
  "Activ. Ex.",
];
export const LIFT_PLAN_HEADERS = [
  DATE_HEADER,
  LIFT_HEADER,
  SET_HEADER,
  LIFT_WEIGHT_HEADER,
  REPS_HEADER,
  NOTES_HEADER,
];

export const LiftRecordRequiredKeys: Array<keyof LiftRecord> = [
  "program",
  "cycleNum",
  "workoutNum",
  "date",
  "lift",
  "setNum",
  "weight",
  "reps",
  "notes",
];
