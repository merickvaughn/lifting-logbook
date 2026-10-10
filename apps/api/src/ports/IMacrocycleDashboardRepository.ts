import { MacrocycleDashboard } from '@lifting-logbook/core';

export interface IMacrocycleDashboardRepository {
  getMacrocycleDashboard(program: string): Promise<MacrocycleDashboard>;

  saveMacrocycleDashboard(dashboard: MacrocycleDashboard): Promise<void>;

  /** Deletes the macrocycle dashboard row for a program. No-op if none exists. */
  deleteMacrocycleDashboard(program: string): Promise<void>;
}
