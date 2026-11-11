import { MacrocycleDashboard } from '@lifting-logbook/core';
import { IMacrocycleDashboardRepository } from '../../ports/IMacrocycleDashboardRepository';
import { ProgramNotFoundError } from '../../ports/errors';
import { SEED_PROGRAM, seedMacrocycleDashboard } from './fixtures';
import { NumberedStore } from './renumber';

export class InMemoryMacrocycleDashboardRepository
  implements IMacrocycleDashboardRepository, NumberedStore
{
  private dashboards: Map<string, MacrocycleDashboard>;

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    const dashboard = this.dashboards.get(program);
    const to = dashboard && changes.get(dashboard.macrocycleNum);
    if (!dashboard || to === undefined) return 0;
    this.dashboards.set(program, { ...dashboard, macrocycleNum: to });
    return 1;
  }

  numbersHeld(program: string): Set<number> {
    const dashboard = this.dashboards.get(program);
    return new Set(dashboard ? [dashboard.macrocycleNum] : []);
  }

  dropNumbers(program: string, macrocycleNums: readonly number[]): void {
    const dashboard = this.dashboards.get(program);
    if (dashboard && macrocycleNums.includes(dashboard.macrocycleNum)) this.dashboards.delete(program);
  }

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
