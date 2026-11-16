import {
  LiftProgressionType,
  UserSettingsResponse,
  UserWorkoutSchedule,
  WeightUnit,
} from '@lifting-logbook/types';

/** The default progression as written: an omitted increment or range end is stored as null. */
export interface DefaultProgressionPatch {
  type: LiftProgressionType;
  increment?: number | null;
  repsLow?: number | null;
  repsHigh?: number | null;
}

export interface UpsertSettingsPatch {
  // It's switched by POST /programs/:program/switch, and UpdateSettingsDto rejects `null`, so
  // the settings route can't clear it. Only an import's undo passes `null`, putting back a user
  // who had no active program before the import continued a run (#1180).
  activeProgram?: string | null;
  // Explicit `null` clears the schedule; `undefined` leaves it unchanged.
  workoutSchedule?: UserWorkoutSchedule | null;
  // Explicit `null` clears the override (falls back to the 1.25 app default);
  // `undefined` leaves it unchanged.
  defaultWeightIncrement?: number | null;
  // Explicit `null` clears the preference (falls back to 'lbs'); `undefined`
  // leaves it unchanged.
  unit?: WeightUnit | null;
  // Replaces the whole default progression (#1210); explicit `null` clears it so each lift's
  // catalog default applies; `undefined` leaves it unchanged.
  defaultProgression?: DefaultProgressionPatch | null;
}

export interface IUserSettingsRepository {
  getSettings(): Promise<UserSettingsResponse>;
  upsertSettings(patch: UpsertSettingsPatch): Promise<UserSettingsResponse>;
}
