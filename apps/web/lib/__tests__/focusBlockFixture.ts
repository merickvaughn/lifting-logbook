import type { FocusBlockResponse } from '@lifting-logbook/types';

/** An active Shoulders focus block for October 2026; override what a test needs. */
export function makeBlock(overrides: Partial<FocusBlockResponse> = {}): FocusBlockResponse {
  return {
    id: 'b1',
    series: 's1',
    area: 'Shoulders',
    period: 'monthly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    priority: 1,
    timer: { prep: 10, set: 45, rest: 60 },
    onEnd: 'prompt',
    nextArea: null,
    pool: [],
    status: 'active',
    rangeStart: '2026-10-01',
    rangeEnd: '2026-10-31',
    ...overrides,
  };
}
