import { WeekType } from '@lifting-logbook/types';

// DashboardMacrocycle model for dashboard macrocycle records
export enum Weekday {
  Sunday = "Sunday",
  Monday = "Monday",
  Tuesday = "Tuesday",
  Wednesday = "Wednesday",
  Thursday = "Thursday",
  Friday = "Friday",
  Saturday = "Saturday",
}

export interface MacrocycleDashboard {
  program: string;
  macrocycleUnit: string;
  macrocycleNum: number;
  macrocycleDate: Date;
  sheetName: string;
  macrocycleStartWeekday: Weekday;
  // Derived at request time via weekTypeForDate(); not stored on the dashboard sheet.
  currentWeekType?: WeekType;
  programType?: string;
}
