import { UserSettingsResponse, UserWorkoutSchedule, WeightUnit } from '@lifting-logbook/types';

export interface UpsertSettingsPatch {
  // No clear-via-null semantics (unlike the three fields below) — it's switched by
  // POST /programs/:program/switch, not cleared here. UpdateSettingsDto rejects `null`
  // explicitly so this type can stay `string` rather than `string | null`.
  activeProgram?: string;
  // Explicit `null` clears the schedule; `undefined` leaves it unchanged.
  workoutSchedule?: UserWorkoutSchedule | null;
  // Explicit `null` clears the override (falls back to the 1.25 app default);
  // `undefined` leaves it unchanged.
  defaultWeightIncrement?: number | null;
  // Explicit `null` clears the preference (falls back to 'lbs'); `undefined`
  // leaves it unchanged.
  unit?: WeightUnit | null;
}

export interface IUserSettingsRepository {
  getSettings(): Promise<UserSettingsResponse>;
  upsertSettings(patch: UpsertSettingsPatch): Promise<UserSettingsResponse>;
}
