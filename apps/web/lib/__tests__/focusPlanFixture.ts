// Builders for focus-plan API responses (#1058), shared by the focus helper and
// workout-details tests so each spells out only what it is about.
import {
  DEFAULT_FOCUS_TIMER,
  emptyFocusDayState,
  type FocusBlockResponse,
  type FocusDayPlanResponse,
  type FocusPlanGroupResponse,
  type FocusPlanItemResponse,
  type FocusPoolEntry,
} from '@lifting-logbook/types';

export function poolEntry(lift: string, overrides: Partial<FocusPoolEntry> = {}): FocusPoolEntry {
  return {
    lift,
    include: 'auto',
    ruleLift: '',
    swapTo: '',
    sets: 3,
    repsLow: 10,
    repsHigh: 12,
    weight: 25,
    trainingMax: 40,
    percent: 65,
    rpe: 8,
    ...overrides,
  };
}

export function focusBlock(overrides: Partial<FocusBlockResponse> = {}): FocusBlockResponse {
  return {
    id: 'b-shoulders',
    series: 'b-shoulders',
    area: 'Shoulders',
    period: 'quarterly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    priority: 1,
    timer: { ...DEFAULT_FOCUS_TIMER },
    onEnd: 'prompt',
    nextArea: null,
    pool: [poolEntry('Lateral Raise'), poolEntry('Face Pull')],
    status: 'active',
    rangeStart: '2026-10-01',
    rangeEnd: '2026-12-31',
    ...overrides,
  };
}

export function planItem(lift: string, sets = 3, overrides: Partial<FocusPlanItemResponse> = {}): FocusPlanItemResponse {
  return {
    lift,
    sets,
    entry: poolEntry(lift, { sets }),
    prescription: { progression: 'double', sets, repsLow: 10, repsHigh: 12, weight: 25, lastReps: null },
    ...overrides,
  };
}

export function planGroup(overrides: Partial<FocusPlanGroupResponse> = {}): FocusPlanGroupResponse {
  const block = overrides.block ?? focusBlock();
  return {
    block,
    mode: block.selection,
    items: [planItem('Lateral Raise'), planItem('Face Pull')],
    skipped: [],
    suggestions: [],
    overlap: null,
    trimmed: [],
    ...overrides,
  };
}

export function focusPlan(overrides: Partial<FocusDayPlanResponse> = {}): FocusDayPlanResponse {
  return {
    program: '5-3-1',
    macrocycleNum: 1,
    workoutNum: 1,
    today: '2026-10-26',
    plannedLifts: ['Squat'],
    budget: { sets: 9, minutes: 20 },
    dayState: emptyFocusDayState(),
    groups: [planGroup()],
    sets: 6,
    seconds: 600,
    over: false,
    suggestion: null,
    ...overrides,
  };
}
