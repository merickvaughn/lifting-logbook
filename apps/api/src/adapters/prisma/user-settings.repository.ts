import { Prisma } from '@prisma/client';
import {
  DefaultProgressionSetting,
  UserSettingsResponse,
  isLiftProgressionType,
  WeightUnit,
  isValidSchedule,
} from '@lifting-logbook/types';
import { PrismaExecutor } from './prisma-tx.util';
import { IUserSettingsRepository, UpsertSettingsPatch } from '../../ports/IUserSettingsRepository';

// Runtime guard for values read from the JSONB column. Prisma returns whatever JSON is
// stored — a manual DB edit or a pre-validator row could violate the type. Delegates to
// the shared `isValidSchedule` predicate so the read-side bounds stay locked to the
// write-side DTO bounds.
function parseSchedule(value: unknown): UserSettingsResponse['workoutSchedule'] {
  if (value === null || value === undefined) return null;
  return isValidSchedule(value) ? value : null;
}

// Runtime guard for the plain-string `unit` column — same rationale as parseSchedule
// above. The column has no DB-level CHECK constraint, only DTO validation on write.
function parseUnit(value: unknown): WeightUnit | null {
  return value === 'lbs' || value === 'kg' ? value : null;
}

type DefaultProgressionColumns = {
  defaultProgression: string | null;
  defaultProgressionIncrement: number | null;
  defaultProgressionRepsLow: number | null;
  defaultProgressionRepsHigh: number | null;
};

// Same rationale again (#1210): an unknown stored type reads as unset, so the catalog applies.
function parseDefaultProgression(row: DefaultProgressionColumns | null): DefaultProgressionSetting | null {
  const type = row?.defaultProgression;
  if (!row || !isLiftProgressionType(type)) return null;
  return {
    type,
    increment: row.defaultProgressionIncrement,
    repsLow: row.defaultProgressionRepsLow,
    repsHigh: row.defaultProgressionRepsHigh,
  };
}

export class PrismaUserSettingsRepository implements IUserSettingsRepository {
  constructor(
    private readonly prisma: PrismaExecutor,
    private readonly userId: string,
  ) {}

  // Note: upsertSettings is last-write-wins across concurrent PATCH calls for the same
  // user. Acceptable for a single-tab settings flow; revisit if a multi-writer scenario
  // is introduced (e.g., background recalculation that mutates schedule).
  async getSettings(): Promise<UserSettingsResponse> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId: this.userId },
    });
    return {
      activeProgram: row?.activeProgram ?? null,
      workoutSchedule: parseSchedule(row?.workoutSchedule),
      defaultWeightIncrement: row?.defaultWeightIncrement ?? null,
      unit: parseUnit(row?.unit),
      defaultProgression: parseDefaultProgression(row),
    };
  }

  async upsertSettings(patch: UpsertSettingsPatch): Promise<UserSettingsResponse> {
    const update: Prisma.UserSettingsUncheckedUpdateInput = {};
    if (patch.activeProgram !== undefined) update.activeProgram = patch.activeProgram;
    if (patch.workoutSchedule !== undefined) {
      update.workoutSchedule =
        patch.workoutSchedule === null
          ? Prisma.JsonNull
          : // validated by WorkoutScheduleDto before reaching the repository
            (patch.workoutSchedule as unknown as Prisma.InputJsonValue);
    }
    if (patch.defaultWeightIncrement !== undefined) {
      update.defaultWeightIncrement = patch.defaultWeightIncrement;
    }
    if (patch.unit !== undefined) update.unit = patch.unit;
    // The four columns are written together, so a new default never inherits a stale range
    // or increment from the one it replaces.
    const progression =
      patch.defaultProgression === undefined
        ? {}
        : {
            defaultProgression: patch.defaultProgression?.type ?? null,
            defaultProgressionIncrement: patch.defaultProgression?.increment ?? null,
            defaultProgressionRepsLow: patch.defaultProgression?.repsLow ?? null,
            defaultProgressionRepsHigh: patch.defaultProgression?.repsHigh ?? null,
          };
    Object.assign(update, progression);

    const create: Prisma.UserSettingsUncheckedCreateInput = { userId: this.userId };
    if (patch.activeProgram !== undefined) create.activeProgram = patch.activeProgram;
    if (patch.workoutSchedule != null) {
      create.workoutSchedule = patch.workoutSchedule as unknown as Prisma.InputJsonValue;
    }
    if (patch.defaultWeightIncrement != null) {
      create.defaultWeightIncrement = patch.defaultWeightIncrement;
    }
    if (patch.unit != null) create.unit = patch.unit;
    Object.assign(create, progression);

    const row = await this.prisma.userSettings.upsert({
      where: { userId: this.userId },
      create,
      update,
    });
    return {
      activeProgram: row.activeProgram ?? null,
      workoutSchedule: parseSchedule(row.workoutSchedule),
      defaultWeightIncrement: row.defaultWeightIncrement ?? null,
      unit: parseUnit(row.unit),
      defaultProgression: parseDefaultProgression(row),
    };
  }
}
