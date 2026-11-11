import {
  DefaultProgressionSetting,
  UserSettingsResponse,
  UserWorkoutSchedule,
  WeightUnit,
} from '@lifting-logbook/types';
import { IUserSettingsRepository, UpsertSettingsPatch } from '../../ports/IUserSettingsRepository';

export class InMemoryUserSettingsRepository implements IUserSettingsRepository {
  private activeProgram: string | null = null;
  private workoutSchedule: UserWorkoutSchedule | null = null;
  private defaultWeightIncrement: number | null = null;
  private unit: WeightUnit | null = null;
  private defaultProgression: DefaultProgressionSetting | null = null;

  async getSettings(): Promise<UserSettingsResponse> {
    return {
      activeProgram: this.activeProgram,
      workoutSchedule: this.workoutSchedule,
      defaultWeightIncrement: this.defaultWeightIncrement,
      unit: this.unit,
      defaultProgression: this.defaultProgression,
    };
  }

  // Mirrors PrismaUserSettingsRepository's patch semantics: `undefined` leaves a field
  // unchanged, explicit `null` clears it (activeProgram has no clear semantics — see
  // UpsertSettingsPatch).
  async upsertSettings(patch: UpsertSettingsPatch): Promise<UserSettingsResponse> {
    if (patch.activeProgram !== undefined) this.activeProgram = patch.activeProgram;
    if (patch.workoutSchedule !== undefined) this.workoutSchedule = patch.workoutSchedule;
    if (patch.defaultWeightIncrement !== undefined) {
      this.defaultWeightIncrement = patch.defaultWeightIncrement;
    }
    if (patch.unit !== undefined) this.unit = patch.unit;
    if (patch.defaultProgression !== undefined) {
      this.defaultProgression = patch.defaultProgression && {
        type: patch.defaultProgression.type,
        increment: patch.defaultProgression.increment ?? null,
        repsLow: patch.defaultProgression.repsLow ?? null,
        repsHigh: patch.defaultProgression.repsHigh ?? null,
      };
    }
    return this.getSettings();
  }

  setSchedule(schedule: UserWorkoutSchedule | null): void {
    this.workoutSchedule = schedule;
  }

  setActiveProgram(program: string | null): void {
    this.activeProgram = program;
  }

  setDefaultWeightIncrement(increment: number | null): void {
    this.defaultWeightIncrement = increment;
  }

  setUnit(unit: WeightUnit | null): void {
    this.unit = unit;
  }
}
