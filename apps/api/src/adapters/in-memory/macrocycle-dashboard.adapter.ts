import { MacrocycleDashboard } from '@lifting-logbook/core';
import { IMacrocycleDashboardRepository } from '../../ports/IMacrocycleDashboardRepository';
import { ProgramNotFoundError } from '../../ports/errors';
import { SEED_PROGRAM, seedMacrocycleDashboard } from './fixtures';
import { TrainingRow } from '../../ports/ITrainingDataRepository';
import { NumberedStore } from './renumber';
import { TrainingStore } from './training-data.adapter';

export class InMemoryMacrocycleDashboardRepository
  implements IMacrocycleDashboardRepository, NumberedStore, TrainingStore
{
  private dashboards: Map<string, MacrocycleDashboard>;

  readonly trainingTable = 'macrocycleDashboards';

  trainingRows(): TrainingRow[] {
    return [...this.dashboards.values()].map((d) => ({ ...d }));
  }

  clearTraining(): void {
    this.dashboards.clear();
  }

  restoreTraining(rows: readonly TrainingRow[]): number {
    let added = 0;
    for (const row of rows) {
      if (this.dashboards.has(row.program)) continue;
      this.dashboards.set(row.program, row as unknown as MacrocycleDashboard);
      added++;
    }
    return added;
  }

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    const dashboard = this.dashboards.get(program);
    const to = dashboard && changes.get(dashboard.macrocycleNum);
    if (!dashboard || to === undefined) return 0;
    this.dashboards.set(program, { ...dashboard, macrocycleNum: to });
    return 1;
  }

  readonly table = 'macrocycle_dashboard';

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
}
