import { UserSettingsResponse, UserWorkoutSchedule, WeightUnit } from '@lifting-logbook/types';

export interface UpsertSettingsPatch {
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
