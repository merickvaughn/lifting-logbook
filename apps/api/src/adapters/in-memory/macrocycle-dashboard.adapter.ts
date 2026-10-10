import { MacrocycleDashboard } from '@lifting-logbook/core';
import { IMacrocycleDashboardRepository } from '../../ports/IMacrocycleDashboardRepository';
import { ProgramNotFoundError } from '../../ports/errors';
import { SEED_PROGRAM, seedMacrocycleDashboard } from './fixtures';

export class InMemoryMacrocycleDashboardRepository
  implements IMacrocycleDashboardRepository
{
  private dashboards: Map<string, MacrocycleDashboard>;

  constructor(preSeed = false) {
    this.dashboards = preSeed
      ? new Map([[SEED_PROGRAM, seedMacrocycleDashboard()]])
      : new Map();
  }

  async getMacrocycleDashboard(program: string): Promise<MacrocycleDashboard> {
    const dashboard = this.dashboards.get(program);
    if (!dashboard) {
      throw new ProgramNotFoundError(program);
    }
    return dashboard;
  }

  async saveMacrocycleDashboard(dashboard: MacrocycleDashboard): Promise<void> {
    this.dashboards.set(dashboard.program, dashboard);
  }

  async deleteMacrocycleDashboard(program: string): Promise<void> {
    this.dashboards.delete(program);
  }
}
