import { MacrocycleDashboard } from '@lifting-logbook/core';

export interface IMacrocycleDashboardRepository {
  getMacrocycleDashboard(program: string): Promise<MacrocycleDashboard>;

  saveMacrocycleDashboard(dashboard: MacrocycleDashboard): Promise<void>;
}
