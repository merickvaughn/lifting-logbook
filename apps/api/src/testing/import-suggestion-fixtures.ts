import {
  segmentLiftHistory,
  toLiftHistoryRecord,
  type KnownProgram,
  type LiftRecord,
  type SegmentedLiftHistory,
} from '@lifting-logbook/core';
import type { SuggestionProgram, SuggestionRow } from '../import-suggestions/suggestion-payload';

/**
 * Parsed lift-record rows and their rules grouping, for the import suggestion tests (#1174).
 * Spec-only: tsconfig.build.json leaves src/testing out of the build.
 */

export const IMPORT_DATE = new Date('2026-11-14T00:00:00Z');

const DAY_MS = 86_400_000;
const BASE = new Date('2026-01-05T00:00:00Z').getTime();
export const dayOf = (n: number) => new Date(BASE + n * DAY_MS);
export const ymdOf = (n: number) => dayOf(n).toISOString().slice(0, 10);

export interface SessionSpec {
  day: number;
  lifts: string[];
  setsPerLift?: number;
  notes?: string;
  weight?: number;
}

/** One row per set: `setsPerLift` sets of each lift, 5 reps, at `weight` rising by set. */
export function rowsOf(sessions: readonly SessionSpec[]): LiftRecord[] {
  return sessions.flatMap((s) =>
    s.lifts.flatMap((lift) =>
      Array.from({ length: s.setsPerLift ?? 3 }, (_, i) => ({
        program: '',
        macrocycleNum: Number.NaN,
        workoutNum: Number.NaN,
        date: dayOf(s.day),
        lift,
        setNum: i + 1,
        weight: (s.weight ?? 200) + i * 10,
        reps: 5,
        notes: s.notes ?? '',
      })),
    ),
  );
}

/** `count` 5/3/1 sessions every other day from `start`, alternating its two days. */
export function fiveThreeOne(start: number, count: number, extra: Partial<SessionSpec> = {}): SessionSpec[] {
  const days = [
    ['back-squat', 'bench-press'],
    ['deadlift', 'overhead-press'],
  ];
  return Array.from({ length: count }, (_, i) => ({ day: start + i * 2, lifts: days[i % 2] ?? [], ...extra }));
}

export function segment(
  rows: readonly LiftRecord[],
  customPrograms: readonly KnownProgram[] = [],
): SegmentedLiftHistory<SuggestionRow> {
  return segmentLiftHistory(rows.map(toLiftHistoryRecord), {
    importDate: IMPORT_DATE,
    sourceProgram: '5-3-1',
    customPrograms,
    placeByDate: true,
  });
}

export const PROGRAMS: SuggestionProgram[] = [
  { id: '5-3-1', name: null, workouts: 24, weeks: 12 },
  { id: 'rpt', name: null, workouts: 24, weeks: 8 },
];

/** The two-run file most tests use: 5/3/1 for 8 sessions, a 30-day break, then 6 more. */
export function twoRuns(extra: Partial<SessionSpec> = {}): LiftRecord[] {
  return rowsOf([...fiveThreeOne(0, 8, extra), ...fiveThreeOne(44, 6, extra)]);
}

/**
 * Every field path a suggestion payload may carry (#1174, proposal decision 11). An array's items
 * are written `[]`. `sessions[].sets[].notes` only when the lifter opts in.
 */
export const ALLOWED_PAYLOAD_PATHS: ReadonlySet<string> = new Set([
  'importDate',
  'exportedFile',
  'programs[].id',
  'programs[].name',
  'programs[].workouts',
  'programs[].weeks',
  'stretches[].start',
  'stretches[].end',
  'stretches[].program',
  'stretches[].matched',
  'stretches[].status',
  'stretches[].startReason',
  'stretches[].sessions',
  'stretches[].completedWorkouts',
  'stretches[].expectedWorkouts',
  'flags.lone',
  'flags.lone[].date',
  'flags.lone[].daysAfterPrevious',
  'flags.lone[].daysBeforeNext',
  'flags.unnumbered',
  'flags.unnumbered[]',
  'flags.conflicts',
  'flags.conflicts[].kind',
  'flags.conflicts[].from',
  'flags.conflicts[].to',
  'flags.conflicts[].days',
  'flags.conflicts[].stretches',
  'flags.conflicts[].stretches[]',
  'sessions[].date',
  'sessions[].sets[].lift',
  'sessions[].sets[].set',
  'sessions[].sets[].weight',
  'sessions[].sets[].reps',
  'sessions[].sets[].notes',
  'sessions[].topSets[].lift',
  'sessions[].topSets[].weight',
  'sessions[].topSets[].reps',
]);

/** Every leaf path in `value`, arrays as `[]`. An empty array or object is a leaf. */
export function payloadPaths(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      if (v.length === 0) out.add(path);
      v.forEach((item) => walk(item, `${path}[]`));
    } else if (typeof v === 'object' && v !== null) {
      const entries = Object.entries(v);
      if (entries.length === 0) out.add(path);
      for (const [key, child] of entries) walk(child, path === '' ? key : `${path}.${key}`);
    } else {
      out.add(path);
    }
  };
  walk(value, prefix);
  return out;
}
