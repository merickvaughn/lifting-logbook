// Lightweight mock API server for Playwright E2E tests.
// Started by playwright.config.ts via webServer; Next.js is pointed at it via API_URL.
// No npm dependencies — plain Node.js http module only.
import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// Canned data
// ---------------------------------------------------------------------------

const MACROCYCLE_DASHBOARD = {
  program: '5-3-1',
  macrocycleNum: 1,
  macrocycleStartDate: '2025-01-06',
  currentWeekType: 'training',
  weeks: [
    {
      week: 1,
      completed: false,
      workouts: [
        { workoutNum: 1, date: '2025-01-06', skipped: false },
        { workoutNum: 2, date: '2025-01-08', skipped: false },
        { workoutNum: 3, date: '2025-01-10', skipped: false },
      ],
    },
  ],
  // Top-level per-workout metadata the Macrocycle Dashboard reads instead of a
  // per-workout fetch (issue #740). skippedWorkoutNums is filled from state below.
  dateOverrides: {},
  skippedWorkoutNums: [],
  completedWorkoutNums: [],
};

const WORKOUT = {
  program: '5-3-1',
  macrocycleNum: 1,
  workoutNum: 1,
  week: 1,
  // The day's offset, as the real API sends it (#1014), so e2e exercises the
  // same day resolution production does. Every PROGRAM_SPEC row is on offset 0.
  offset: 0,
  date: '2025-01-06',
  skipped: false,
  // Unlogged planned lifts carry no sets, as the real API sends them
  // (`toWorkoutResponse`): pages derive the plan from PROGRAM_SPEC (#1080).
  lifts: [
    { lift: 'squat', planned: true, sets: [] },
    { lift: 'deadlift', planned: true, sets: [] },
  ],
};

// `activation` is the spec's own free-text column. Squat carries a real movement
// name so the timer's activation phase (#960) is exercised end to end; the other
// three keep the legacy `'none'` placeholder, which must produce no phase at all.
const PROGRAM_SPEC = [
  { week: 1, lift: 'squat', order: 1, offset: 0, increment: 5, sets: 3, reps: 5, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0, activation: 'Hip Airplane' },
  { week: 1, lift: 'deadlift', order: 2, offset: 0, increment: 5, sets: 3, reps: 5, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0, activation: 'none' },
  { week: 1, lift: 'bench-press', order: 3, offset: 0, increment: 5, sets: 3, reps: 5, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0, activation: 'none' },
  { week: 1, lift: 'overhead-press', order: 4, offset: 0, increment: 5, sets: 3, reps: 5, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0, activation: 'none' },
];

const TM_HISTORY = {
  entries: [
    { id: 'h1', lift: 'squat', weight: 300, unit: 'lbs', date: '2025-01-01', isPR: false, source: 'test', goalMet: false },
    { id: 'h2', lift: 'bench-press', weight: 200, unit: 'lbs', date: '2025-01-01', isPR: false, source: 'test', goalMet: false },
    { id: 'h3', lift: 'deadlift', weight: 350, unit: 'lbs', date: '2025-01-01', isPR: false, source: 'test', goalMet: false },
    { id: 'h4', lift: 'overhead-press', weight: 135, unit: 'lbs', date: '2025-01-01', isPR: false, source: 'test', goalMet: false },
  ],
};

// GET /programs/:p/macrocycles (#1197): one imported macrocycle before the current one.
const MACROCYCLES = [
  { id: 'mc-1', macrocycleNum: 1, startDate: '2024-09-02', endDate: '2024-10-25', status: 'completed', origin: 'imported', current: false, unmatched: false },
  { id: 'mc-2', macrocycleNum: 2, startDate: '2025-01-06', endDate: null, status: 'in-progress', origin: 'live', current: true, unmatched: false },
];

const INITIAL_TRAINING_MAXES = [
  { lift: 'squat', weight: 300, unit: 'lbs', dateUpdated: '2025-01-01' },
  { lift: 'bench-press', weight: 200, unit: 'lbs', dateUpdated: '2025-01-01' },
  { lift: 'deadlift', weight: 350, unit: 'lbs', dateUpdated: '2025-01-01' },
  { lift: 'overhead-press', weight: 135, unit: 'lbs', dateUpdated: '2025-01-01' },
];

const LIFT_RECORDS = [
  { id: 'r1', program: '5-3-1', macrocycleNum: 1, workoutNum: 1, date: '2025-01-06', lift: 'squat', setNum: 1, weight: 195, reps: 5, notes: '' },
  { id: 'r2', program: '5-3-1', macrocycleNum: 1, workoutNum: 1, date: '2025-01-06', lift: 'deadlift', setNum: 1, weight: 230, reps: 5, notes: '' },
];

// Single source of truth for the #911 ambiguous-lift preview/commit scenario
// (withAmbiguousLift) — both the canned preview deltas and the commit branch's
// "are all rows resolved" check derive from this list, so growing it doesn't
// require a matching hand-edit at the commit branch too.
const AMBIGUOUS_LIFT_ROWS = [
  { rowIndex: 1, originalLift: 'Wide-Grip CBL Curls' },
  { rowIndex: 2, originalLift: 'Wide-Grip CBL Curls' },
];

// The Assign step (#1256). A file with no program, macrocycle or workout columns, which the
// step on doesn't ask for (#1253).
const ASSIGN_PREVIEW = {
  classification: { type: 'lift-records', confidence: 0.95, bucket: 'high', reasons: [], alternatives: [] },
  destination: 'lift-records',
  columnMappings: ['Date', 'Lift', 'Set #', 'Weight', 'Reps'].map((header, i) => ({
    sourceHeader: header,
    destinationField: ['date', 'lift', 'setNum', 'weight', 'reps'][i],
    confidence: 1,
    required: true,
  })),
  preview: {
    creates: 1,
    updates: 0,
    skips: 0,
    unresolved: 0,
    deltas: [{ key: 'squat-1', label: 'Squat', kind: 'create', status: 'ok', rowIndex: 1 }],
  },
  errors: [],
  assignEnabled: true,
};

// A long history: 30 macrocycles of three sessions, three weeks apart, with a one-lift
// session in each of the first 20 breaks. The first has no status, so it stays open; the
// rest are settled, so they collapse to one line.
const ASSIGN_DAY = (offset) => new Date(Date.UTC(2024, 0, 1) + offset * 86400000).toISOString().slice(0, 10);
const ASSIGN_RESPONSE = {
  importDate: '2026-11-13',
  sessions: 110,
  stretches: Array.from({ length: 30 }, (_, i) => {
    const dates = [0, 2, 4].map((d) => ASSIGN_DAY(i * 21 + d));
    return {
      program: 'rpt',
      matched: true,
      liftsOutsideProgram: [],
      candidateProgram: null,
      fileMacrocycleNum: null,
      fileGroup: null,
      stored: { kind: 'new' },
      startDate: dates[0],
      endDate: dates[2],
      // The first also has a lift RPT doesn't plan, for the lifter to confirm its progression (#1212).
      sessions: dates.map((date, n) => ({
        date,
        workoutNum: n + 1,
        lifts: i === 0 ? ['Squat', 'Bench Press', 'Face Pull'] : ['Squat', 'Bench Press'],
        sets: i === 0 ? 9 : 6,
      })),
      completedWorkouts: 3,
      expectedWorkouts: 24,
      status: i === 0 ? null : 'abandoned',
      fileStatus: null,
      reasons: {
        start: i === 0 ? { kind: 'first-session' } : { kind: 'gap', days: 17 },
        program: { kind: 'lifts', tiedWith: [], bySetOrder: false },
        status: i === 0 ? { kind: 'unmatched' } : { kind: 'next-is-restart' },
      },
    };
  }),
  lone: Array.from({ length: 20 }, (_, i) => ({
    session: { date: ASSIGN_DAY(i * 21 + 12), workoutNum: null, lifts: ['Bench Press'], sets: 3 },
    daysAfterPrevious: 8,
    daysBeforeNext: 9,
  })),
  nonCycle: [],
  unnumbered: [],
  conflicts: [],
  undatedRows: 0,
  exported: false,
  // A custom program's name, so the spec doesn't depend on the built-in catalog's wording.
  programs: [{ id: 'rpt', name: 'RPT', workouts: 24, weeks: 8 }],
  lifts: [
    { name: 'Squat', metadataLift: 'Squat', programs: ['rpt'], progression: 'linear' },
    { name: 'Bench Press', metadataLift: 'Bench Press', programs: ['rpt'], progression: 'linear' },
    { name: 'Face Pull', metadataLift: 'Face Pull', programs: [], progression: 'double' },
  ],
  // No LLM provider, so the step shows no suggestions question (#1174).
  suggestions: null,
  // No run to continue as current unless withContinue (#1180).
  continue: null,
};

// withContinue's offer (#1180): the last stretch continues as current, ending a live macrocycle
// with 12 sets. Squat has a max to keep; Bench Press has none and nothing computed, so it needs a value.
const CONTINUE_OFFER = {
  stretch: ASSIGN_RESPONSE.stretches.length - 1,
  live: { id: 'mc-live', macrocycleNum: 3, sets: 12 },
  maxes: [
    { lift: 'Squat', name: 'Squat', current: 200, computed: 210 },
    { lift: 'Bench Press', name: 'Bench Press', current: null, computed: null },
  ],
};

// Column mappings for the Google Sheets LIFT_RECORDS tab's preview (#1111) —
// every required lift-record field mapped, so MAP_COLUMNS lets the user continue.
const SHEET_LIFT_RECORD_MAPPINGS = [
  ['Program', 'program'],
  ['Cycle #', 'macrocycleNum'],
  ['Workout #', 'workoutNum'],
  ['Date', 'date'],
  ['Lift', 'lift'],
  ['Set #', 'setNum'],
  ['Weight', 'weight'],
  ['Reps', 'reps'],
].map(([sourceHeader, destinationField]) => ({ sourceHeader, destinationField, confidence: 1, required: true }));

// ---------------------------------------------------------------------------
// In-memory state (reset between tests via GET /__reset)
// ---------------------------------------------------------------------------

const NO_TRAINING_DATA = {
  liftRecords: 0,
  macrocycles: 0,
  macrocycleDashboards: 0,
  macrocycleScheduledWorkouts: 0,
  trainingMaxes: 0,
  trainingMaxHistory: 0,
  liftModificationMaxes: 0,
  workoutDateOverrides: 0,
  workoutSkipOverrides: 0,
  workoutLiftOverrides: 0,
  focusDayStates: 0,
  importBatches: 0,
};

const CUSTOM_PROGRAM = {
  id: 'cust-1',
  name: 'My Custom Program',
  description: null,
  baseTemplate: null,
  createdAt: '2026-01-01',
};

const GOOGLE_SHEET_LINKED = {
  configured: true,
  status: 'linked',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/mock-sheet/edit',
  lastMirroredAt: '2026-11-22T15:30:00.000Z',
  syncFailed: false,
};

function createInitialState() {
  return {
    noCurrentMacrocycle: false,
    // POST /programs/:p/switch changes it, as on the API, so History can be read after a switch (#1304).
    activeProgram: '5-3-1',
    // What Clear data would remove, and the backups it leaves (#1310).
    trainingDataCounts: { ...NO_TRAINING_DATA, liftRecords: 42, macrocycles: 2, trainingMaxes: 4 },
    snapshots: [],
    // /__reset?withClearError=true makes the clear fail with a 500.
    clearError: false,
    // The linked Google Sheet (#1433; not `googleSheet`, the #1111 import flag below). /__reset?googleSheet=linked|failed|unconfigured
    // starts it linked, linked with a failed last sync (#1444), or as an API with no Google client.
    sheetLink: { configured: true, status: 'unlinked', spreadsheetUrl: null, lastMirroredAt: null, syncFailed: false },
    trainingMaxes: structuredClone(INITIAL_TRAINING_MAXES),
    // Lifts with logged sets and no training max (#1246); /__reset?withMissingMax=true seeds one.
    missingMaxes: [],
    missingMaxDismissals: new Set(),
    strengthGoals: [],
    skippedWorkouts: new Set(),
    workoutSchedule: null,
    defaultWeightIncrement: null,
    unit: null,
    defaultProgression: null,
    // Empty by default so the /programs page test still sees RPT as the only
    // program; the import test opts in via /__reset?withCustomProgram=true.
    customPrograms: [],
    // When true, the import preview response includes columnMappings with one
    // required field unmapped, to exercise the MAP_COLUMNS override flow.
    nonStandardColumns: false,
    // When true, an /import preview with no explicit destination returns the
    // low-confidence manual-picker shape, and destination=lift-records returns
    // a preview with one ambiguous lift row — exercises the #911 remap flow.
    ambiguousLift: false,
    // When true, a training-maxes preview reports `Squat` and `Back Squat` as one lift (#1135).
    spellingCollision: false,
    // When true, a strength-goals preview reports `Squat` and `Back Squat` as one lift (#1169).
    goalSpellingCollision: false,
    // Google Sheets import (#1111): googleSheet makes destination=lift-records
    // previews return the canned LIFT_RECORDS tab's preview; privateSheet makes the
    // workbook fetch answer like a sheet that is not link-shared.
    googleSheet: false,
    privateSheet: false,
    // The import's Assign step (#1256): withAssign makes any upload lift history with the
    // step on, and mode=assign return ASSIGN_RESPONSE's long file.
    assign: false,
    // With assign, mode=assign also offers to continue the last stretch as current (#1180).
    continueOffer: false,
    // An Assign commit's macrocycles and its batch (#1257), which History lists and undoes, and
    // the program they went into (#1300).
    assignedMacrocycles: [],
    assignedProgram: null,
    importBatches: [],
    // A training-maxes import Settings lists and undoes (#1405): /__reset?withTrainingMaxImport=true
    // seeds one that raised bench-press from 200 to 210.
    trainingMaxImport: null,
    // GET/POST /lifts/custom (#911) — a user's custom lifts.
    customLifts: [],
    // GET/POST /lifts/modifications (#1152) — the user's lift modifications, for every lift.
    liftModifications: [],
    // /programs/:p/modification-maxes (#1153) — own maxes. One list serves every program.
    modificationMaxes: [],
    // /focus/* (#1057) — the user's focus blocks and daily focus guide. Empty by default;
    // /__reset?withFocusBlocks=true seeds the setup page's set (#1057), and
    // withFocusBlocks=<YYYY-MM-DD> seeds the calendar's set around that day (#1059).
    focusBlocks: [],
    focusGuide: { sets: 9, minutes: 20 },
    // Never reused, so an id created after a delete can't collide with a remaining one.
    focusSeq: 0,
    // Focus work (#1058). Off by default, so a workout reads as it does for a user
    // with no focus blocks; the focus spec opts in via /__reset?withFocus=true, and
    // withFocusError=true makes the plan endpoint fail.
    focus: false,
    focusError: false,
    // Saved focus day state, by workout number.
    focusDayStates: new Map(),
    // Non-cycle workouts (#1184): their sets, as the API's lift records under 'non-cycle'.
    nonCycleRecords: [],
  };
}

const NON_CYCLE_MACROCYCLE_ID = 'mock-non-cycle-macrocycle';

function nonCycleWorkout(workoutNum) {
  const records = state.nonCycleRecords.filter((r) => r.workoutNum === workoutNum);
  if (records.length === 0) return null;
  return { workoutNum, date: records[0].date, macrocycleId: NON_CYCLE_MACROCYCLE_ID, records };
}

function nonCycleRecord(fields) {
  const { lift, date, workoutNum, setNum } = fields;
  return {
    id: `non-cycle-1-${workoutNum}-${date}-${lift}-${setNum}`,
    program: 'non-cycle',
    macrocycleNum: 1,
    workoutNum,
    date,
    lift,
    setNum,
    weight: fields.weight,
    reps: fields.reps,
    notes: fields.notes ?? '',
  };
}

// ---------------------------------------------------------------------------
// Focus blocks for the calendar (#1059), on the #1057 date helpers below
// (focusRange / focusStatus / focusResponse / focusNextStart).
// ---------------------------------------------------------------------------

// True when `predecessor` is owed an auto-roll successor among `blocks`: core's
// expandRollovers rule, which the API's DELETE asks "owed without the deleted block,
// not with it" (apps/api/src/focus/focus.controller.ts `remove`).
function owesRoll(predecessor, blocks) {
  if (predecessor.onEnd !== 'autoroll' || !predecessor.nextArea) return false;
  const start = focusNextStart(predecessor);
  return !blocks.some(
    (b) => b.id !== predecessor.id && b.series === predecessor.series && focusRange(b).end >= start,
  );
}

function focusBlock(fields) {
  return {
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    timer: { prep: 10, set: 45, rest: 60 },
    onEnd: 'prompt',
    nextArea: null,
    pool: [],
    ...fields,
  };
}

// Around `today` (/__reset?withFocusBlocks=<YYYY-MM-DD>): an auto-rolling quarterly
// Shoulders block with its queued Back successor, and a monthly Biceps block that
// prompts, after last month's ended one.
function seedFocusBlocks(today) {
  const [y, m] = today.split('-').map(Number);
  const utcDay = (year, month, day) => new Date(Date.UTC(year, month, day));
  const quarterStart = isoDay(utcDay(y, Math.floor((m - 1) / 3) * 3, 1));
  const shoulders = focusBlock({
    id: 'fb-shoulders', series: 'fs-1', area: 'Shoulders', period: 'quarterly', align: 'calendar',
    start: quarterStart, priority: 1, onEnd: 'autoroll', nextArea: 'Back',
    pool: [focusPoolEntry('Lateral Raise'), focusPoolEntry('Face Pull')],
  });
  return [
    shoulders,
    focusBlock({
      id: 'fb-back', series: 'fs-1', area: 'Back', period: 'quarterly', align: 'calendar',
      start: focusNextStart(shoulders), priority: 3,
    }),
    focusBlock({
      id: 'fb-biceps', series: 'fs-2', area: 'Biceps', period: 'monthly', align: 'calendar',
      start: isoDay(utcDay(y, m - 1, 1)), priority: 2, selection: 'rotate',
      pool: [focusPoolEntry('Hammer Curl')],
    }),
    focusBlock({
      id: 'fb-biceps-prev', series: 'fs-2', area: 'Biceps', period: 'monthly', align: 'calendar',
      start: isoDay(utcDay(y, m - 2, 1)), priority: 9,
    }),
  ];
}

let state = createInitialState();

// ---------------------------------------------------------------------------
// Focus blocks (#1057) — a small mirror of core's date math (packages/core/src/focus/
// dates.ts), since this plain-Node mock cannot import the TypeScript packages.
// ---------------------------------------------------------------------------

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function focusRange(block) {
  const [y, m, d] = block.start.split('-').map(Number);
  if (block.align === 'calendar') {
    const first = block.period === 'quarterly' ? Math.floor((m - 1) / 3) * 3 : m - 1;
    const months = block.period === 'quarterly' ? 3 : 1;
    return { start: isoDay(new Date(Date.UTC(y, first, 1))), end: isoDay(new Date(Date.UTC(y, first + months, 0))) };
  }
  const target = m - 1 + (block.period === 'quarterly' ? 3 : 1);
  const lastDay = new Date(Date.UTC(y, target + 1, 0)).getUTCDate();
  return { start: block.start, end: isoDay(new Date(Date.UTC(y, target, Math.min(d - 1, lastDay)))) };
}

function focusStatus(block, today) {
  const { start, end } = focusRange(block);
  return today < start ? 'queued' : today > end ? 'ended' : 'active';
}

// A stored block's version, which every PATCH raises (ADR-039, Amendment 7). Seeds start at 1.
function focusVersion(block) {
  return block.version ?? 1;
}

function focusResponse(block, today) {
  const { start, end } = focusRange(block);
  return { ...block, version: focusVersion(block), status: focusStatus(block, today), rangeStart: start, rangeEnd: end };
}

function focusNextStart(block) {
  const end = new Date(`${focusRange(block).end}T00:00:00Z`);
  return isoDay(new Date(end.getTime() + 86_400_000));
}

// One accessory per area stands in for core's defaultFocusPool, which this mock can't import.
const FOCUS_AREA_LIFT = {
  Shoulders: 'Lateral Raise',
  Biceps: 'Hammer Curl',
  Triceps: 'Rope Pushdown',
  Back: 'Lat Pulldown',
  Chest: 'Cable Fly',
  Calves: 'Standing Calf Raise',
  Glutes: 'Hip Thrust',
  Core: 'Cable Crunch',
};

/**
 * Mirrors core's expandRollovers as the real API runs it on every read: a started block
 * set to auto-roll gets a successor in its series, from the day after it ends, unless
 * something in the series already runs that late.
 */
function materializeFocusRollovers(today) {
  for (const block of [...state.focusBlocks]) {
    if (block.onEnd !== 'autoroll' || block.nextArea === null || focusStatus(block, today) === 'queued') continue;
    const start = focusNextStart(block);
    const covered = state.focusBlocks.some((other) => other.series === block.series && focusRange(other).end >= start);
    if (covered) continue;
    state.focusSeq += 1;
    state.focusBlocks.push({
      ...block,
      id: `focus-${state.focusSeq}`,
      area: block.nextArea,
      start,
      onEnd: 'prompt',
      nextArea: null,
      priority: state.focusBlocks.reduce((max, b) => Math.max(max, b.priority), 0) + 1,
      pool: [seedPoolEntry(FOCUS_AREA_LIFT[block.nextArea])],
      version: 1,
    });
  }
}

/**
 * A workout's focus plan from the stored focus blocks (#1057). Simplified: every active
 * block's auto/always lifts, with no overlap handling or trims.
 */
function planFromFocusBlocks(program, workoutNum, today) {
  const groups = state.focusBlocks
    .filter((b) => focusStatus(b, today) === 'active')
    .sort((a, b) => a.priority - b.priority)
    .map((b) => ({
      block: focusResponse(b, today),
      mode: b.selection,
      items: b.pool
        .filter((entry) => entry.include === 'auto' || entry.include === 'always')
        .map((entry) => ({
          lift: entry.lift,
          sets: entry.sets,
          entry,
          prescription: {
            progression: 'double',
            sets: entry.sets,
            repsLow: entry.repsLow,
            repsHigh: entry.repsHigh,
            weight: entry.weight,
            lastReps: null,
            progressed: false,
          },
        })),
      skipped: [],
      suggestions: [],
      overlap: null,
      trimmed: [],
    }));
  let sets = 0;
  let seconds = 0;
  for (const group of groups) {
    const { prep, set, rest } = group.block.timer;
    for (const item of group.items) {
      sets += item.sets;
      seconds += item.sets * (prep + set) + Math.max(0, item.sets - 1) * rest + rest;
    }
  }
  return {
    program,
    macrocycleNum: 1,
    workoutNum,
    today,
    plannedLifts: [],
    budget: state.focusGuide,
    dayState: { modes: {}, picks: {}, trims: {}, placement: 'after', order: null, dismissed: false },
    groups,
    sets,
    seconds,
    over: sets > state.focusGuide.sets || seconds / 60 > state.focusGuide.minutes,
    suggestion: null,
  };
}

/** The first day of this calendar quarter, by the mock's clock — for seeded blocks. */
function thisQuarterStart() {
  const now = new Date();
  return isoDay(new Date(Date.UTC(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)));
}

function seedPoolEntry(lift) {
  return { lift, include: 'auto', ruleLift: '', swapTo: '', sets: 3, repsLow: 10, repsHigh: 12, weight: 25, trainingMax: 40, percent: 65, rpe: 8 };
}

function seedFocusBlock(id, area, priority, lifts) {
  return {
    id,
    series: id,
    area,
    period: 'quarterly',
    align: 'calendar',
    start: thisQuarterStart(),
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    priority,
    timer: { prep: 10, set: 45, rest: 60 },
    onEnd: 'prompt',
    nextArea: null,
    pool: lifts.map(seedPoolEntry),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function noContent(res) {
  res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
  res.end();
}

// The real Fastify API rejects an empty or malformed body on an application/json endpoint
// with a 400 (FST_ERR_CTP_EMPTY_JSON_BODY / parse error — see #667). The mock previously
// swallowed both into `{}` and returned 200/201, so a client bug that sent a broken body
// passed the mock-backed Playwright tests while failing against the real API. readBody now
// returns this sentinel for an empty/malformed body; JSON write handlers convert it to a
// 400 via rejectIfInvalidBody() to match real Fastify (#687 / #699).
const INVALID_JSON_BODY = Symbol('invalid-json-body');

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (body === '') {
        resolve(INVALID_JSON_BODY);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(INVALID_JSON_BODY);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Focus work (#1058)
// ---------------------------------------------------------------------------

const FOCUS_TIMER = { prep: 10, set: 45, rest: 60 };
const FOCUS_BUDGET = { sets: 6, minutes: 20 };
const FOCUS_PLACEMENTS = ['before', 'after', 'interleave'];

function focusPoolEntry(lift) {
  return { lift, include: 'auto', ruleLift: '', swapTo: '', sets: 3, repsLow: 10, repsHigh: 12, weight: 25, trainingMax: 40, percent: 65, rpe: 8 };
}

// One active Shoulders focus block of three lifts: nine sets against a six-set
// guide, so the over-guide advice shows until a lift is trimmed.
const FOCUS_BLOCK = {
  id: 'fb-shoulders',
  series: 'fb-shoulders',
  area: 'Shoulders',
  period: 'quarterly',
  align: 'calendar',
  start: '2026-10-01',
  selection: 'rules',
  overlap: 'reduce',
  progression: 'double',
  priority: 1,
  timer: FOCUS_TIMER,
  onEnd: 'prompt',
  nextArea: null,
  pool: ['Lateral Raise', 'Face Pull', 'Arnold Press'].map(focusPoolEntry),
  rangeStart: '2026-10-01',
  rangeEnd: '2026-12-31',
};

function emptyFocusDayState() {
  return { modes: {}, picks: {}, trims: {}, placement: 'after', order: null, dismissed: false };
}

// The limits apps/api/src/focus/focus-day-state.dto.ts enforces, so a request the
// real API would reject with a 400 is rejected here too.
const FOCUS_SELECTIONS = ['rules', 'rotate', 'fixed', 'pick'];
const MAX_KEYS = 50;
const MAX_ITEMS = 50;
const MAX_ID = 100;
const MAX_ORDER = 200;

const isBoundedId = (x) => typeof x === 'string' && x.length <= MAX_ID;
const isBoundedList = (v, max) => Array.isArray(v) && v.length <= max && v.every(isBoundedId);

function isBoundedRecord(value, isValue) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= MAX_KEYS && keys.every(isBoundedId) && Object.values(value).every(isValue);
}

// The shape the real API's FocusDayStateDto accepts.
function isFocusDayState(body) {
  return (
    body !== null &&
    typeof body === 'object' &&
    isBoundedRecord(body.modes, (mode) => FOCUS_SELECTIONS.includes(mode)) &&
    isBoundedRecord(body.picks, (v) => isBoundedList(v, MAX_ITEMS)) &&
    isBoundedRecord(body.trims, (v) => isBoundedList(v, MAX_ITEMS)) &&
    FOCUS_PLACEMENTS.includes(body.placement) &&
    (body.order === null || isBoundedList(body.order, MAX_ORDER)) &&
    typeof body.dismissed === 'boolean'
  );
}

// A canned stand-in for the API's planFocusDay: the day's trims are applied and
// the totals, guide check and trim suggestion recomputed, as core does for one
// focus block. Selection modes and picks are echoed but not re-planned.
function buildFocusPlan(workoutNum, today, dayState) {
  const base = {
    program: '5-3-1',
    macrocycleNum: 1,
    workoutNum,
    today,
    plannedLifts: WORKOUT.lifts.map((l) => l.lift),
    budget: FOCUS_BUDGET,
    dayState,
    groups: [],
    sets: 0,
    seconds: 0,
    over: false,
    suggestion: null,
  };
  if (!state.focus) return base;

  const trims = dayState.trims[FOCUS_BLOCK.id] ?? [];
  const all = FOCUS_BLOCK.pool.map((entry) => ({
    lift: entry.lift,
    sets: entry.sets,
    entry,
    prescription: { progression: 'double', sets: entry.sets, repsLow: entry.repsLow, repsHigh: entry.repsHigh, weight: entry.weight, lastReps: null, progressed: false },
  }));
  const items = all.filter((item) => !trims.includes(item.lift));
  const cost = (sets) => sets * (FOCUS_TIMER.prep + FOCUS_TIMER.set) + Math.max(0, sets - 1) * FOCUS_TIMER.rest + FOCUS_TIMER.rest;
  const sets = items.reduce((n, item) => n + item.sets, 0);
  const seconds = items.reduce((n, item) => n + cost(item.sets), 0);
  const over = sets > FOCUS_BUDGET.sets || seconds / 60 > FOCUS_BUDGET.minutes;
  const last = items[items.length - 1];
  return {
    ...base,
    groups: [
      {
        block: { ...FOCUS_BLOCK, status: 'active' },
        mode: dayState.modes[FOCUS_BLOCK.id] ?? FOCUS_BLOCK.selection,
        items,
        skipped: [],
        suggestions: [],
        overlap: null,
        trimmed: all.filter((item) => trims.includes(item.lift)).map((item) => item.lift),
      },
    ],
    sets,
    seconds,
    over,
    suggestion: over && last ? { blockId: FOCUS_BLOCK.id, lift: last.lift, sets: sets - last.sets, seconds: seconds - cost(last.sets) } : null,
  };
}

// Sends a Fastify-shaped 400 and returns true when the parsed body was empty/malformed.
function rejectIfInvalidBody(res, body) {
  if (body === INVALID_JSON_BODY) {
    json(res, { statusCode: 400, message: 'Body is not valid JSON' }, 400);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3004');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // -------------------------------------------------------------------------
  // Test control: reset state between tests
  // GET /__reset           — reset to defaults
  // GET /__reset?noCurrentMacrocycle=true — reset with no active macrocycle
  // -------------------------------------------------------------------------
  if (url.pathname === '/__reset') {
    state = createInitialState();
    if (url.searchParams.get('noCurrentMacrocycle') === 'true') {
      state.noCurrentMacrocycle = true;
    }
    if (url.searchParams.get('withSchedule') === 'true') {
      state.workoutSchedule = { type: 'fixed', days: [0, 2, 4] }; // Mon/Wed/Fri
    }
    if (url.searchParams.get('withCustomProgram') === 'true') {
      state.customPrograms = [CUSTOM_PROGRAM];
    }
    if (url.searchParams.get('withNonStandardColumns') === 'true') {
      state.nonStandardColumns = true;
    }
    if (url.searchParams.get('withAmbiguousLift') === 'true') {
      state.ambiguousLift = true;
    }
    if (url.searchParams.get('withSpellingCollision') === 'true') {
      state.spellingCollision = true;
    }
    if (url.searchParams.get('withGoalSpellingCollision') === 'true') {
      state.goalSpellingCollision = true;
    }
    if (url.searchParams.get('withAssign') === 'true') {
      state.assign = true;
    }
    if (url.searchParams.get('withContinue') === 'true') {
      state.continueOffer = true;
    }
    if (url.searchParams.get('withGoogleSheet') === 'true') {
      state.googleSheet = true;
    }
    if (url.searchParams.get('withPrivateSheet') === 'true') {
      state.privateSheet = true;
    }
    const withFocusBlocks = url.searchParams.get('withFocusBlocks');
    if (withFocusBlocks === 'true') {
      state.focusBlocks = [
        seedFocusBlock('focus-shoulders', 'Shoulders', 1, ['Lateral Raise', 'Face Pull']),
        seedFocusBlock('focus-biceps', 'Biceps', 2, ['Hammer Curl']),
      ];
    } else if (withFocusBlocks) {
      state.focusBlocks = seedFocusBlocks(withFocusBlocks);
    }
    if (url.searchParams.get('withFocus') === 'true') {
      state.focus = true;
    }
    if (url.searchParams.get('withFocusError') === 'true') {
      state.focusError = true;
    }
    if (url.searchParams.get('withClearError') === 'true') {
      state.clearError = true;
    }
    const googleSheet = url.searchParams.get('googleSheet');
    if (googleSheet === 'linked') state.sheetLink = { ...GOOGLE_SHEET_LINKED };
    if (googleSheet === 'failed') state.sheetLink = { ...GOOGLE_SHEET_LINKED, syncFailed: true };
    if (googleSheet === 'unconfigured') state.sheetLink.configured = false;
    if (url.searchParams.get('withTrainingMaxImport') === 'true') {
      state.trainingMaxImport = {
        batch: { id: 'tm-import-1', program: '5-3-1', createdAt: '2026-11-21T18:04:09.000Z' },
        lift: 'bench-press',
        before: 200,
      };
      state.trainingMaxes.find((m) => m.lift === 'bench-press').weight = 210;
    }
    if (url.searchParams.get('withMissingMax') === 'true') {
      state.missingMaxes = [
        {
          // `lift` as sets store it, `name` to show (#1290).
          lift: 'romanian-deadlift',
          name: 'Romanian Deadlift',
          liftId: 'romanian-deadlift',
          lastLoggedDate: '2025-01-06',
          setCount: 3,
          estimate: { weight: 100, unit: 'lbs', from: { date: '2025-01-06', weight: 100, reps: 5 } },
        },
      ];
    }
    // Workout 1's deadlift, for the Finish workout dialog (#1272): its max is removed, as a lift
    // the real list reports has none.
    if (url.searchParams.get('withWorkoutMissingMax') === 'true') {
      state.trainingMaxes = state.trainingMaxes.filter((m) => m.lift !== 'deadlift');
      state.missingMaxes = [
        {
          lift: 'deadlift',
          name: 'Deadlift',
          liftId: 'deadlift',
          lastLoggedDate: '2025-01-06',
          setCount: 3,
          estimate: { weight: 250, unit: 'lbs', from: { date: '2025-01-06', weight: 250, reps: 5 } },
        },
      ];
    }
    if (url.searchParams.get('withNonCycleWorkout') === 'true') {
      state.nonCycleRecords = [1, 2, 3].map((setNum) =>
        nonCycleRecord({ workoutNum: 1, date: '2026-11-10', lift: 'squat', setNum, weight: 225, reps: 5 }),
      );
    }
    json(res, { ok: true });
    return;
  }

  // -------------------------------------------------------------------------
  // /focus/* — focus blocks and the daily focus guide (#1057)
  // -------------------------------------------------------------------------
  if (parts[0] === 'focus') {
    const today = url.searchParams.get('today');
    // The summary (#1059) takes no `today`, as in the API: its range is the block's own.
    const needsToday = parts[1] === 'blocks' && method !== 'DELETE' && parts[3] !== 'summary';
    if (needsToday && !/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) {
      json(res, { statusCode: 400, message: 'today is required (YYYY-MM-DD)' }, 400);
      return;
    }

    // GET /focus/blocks — creates due auto-roll successors first, as the API does
    if (method === 'GET' && parts[1] === 'blocks' && parts.length === 2) {
      materializeFocusRollovers(today);
      json(res, state.focusBlocks.map((b) => focusResponse(b, today)));
      return;
    }

    // POST /focus/blocks
    if (method === 'POST' && parts[1] === 'blocks' && parts.length === 2) {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      state.focusSeq += 1;
      const id = `focus-${state.focusSeq}`;
      const priority =
        body.priority ??
        state.focusBlocks
          .filter((b) => focusStatus(b, today) !== 'ended')
          .reduce((max, b) => Math.max(max, b.priority), 0) + 1;
      // The API refuses a version on create and starts every block at 1.
      if (body.version !== undefined) {
        json(res, { statusCode: 400, message: ['property version should not exist'], error: 'Bad Request' }, 400);
        return;
      }
      const created = { ...body, id, series: body.series ?? id, priority, version: 1 };
      state.focusBlocks.push(created);
      json(res, focusResponse(created, today), 201);
      return;
    }

    // PUT /focus/blocks/order — every block not ended, highest priority first
    if (method === 'PUT' && parts[1] === 'blocks' && parts[2] === 'order') {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      materializeFocusRollovers(today);
      const current = state.focusBlocks.filter((b) => focusStatus(b, today) !== 'ended').map((b) => b.id);
      const ids = body.ids ?? [];
      if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id))) {
        json(res, { statusCode: 400, message: 'ids must list every focus block that has not ended, exactly once' }, 400);
        return;
      }
      for (const b of state.focusBlocks) {
        const index = ids.indexOf(b.id);
        if (index >= 0) b.priority = index + 1;
      }
      json(res, state.focusBlocks.map((b) => focusResponse(b, today)));
      return;
    }

    // PATCH /focus/blocks/:id
    if (method === 'PATCH' && parts[1] === 'blocks' && parts.length === 3) {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      const existing = state.focusBlocks.find((b) => b.id === decodeURIComponent(parts[2]));
      if (!existing) {
        json(res, { statusCode: 404, message: 'Focus block not found' }, 404);
        return;
      }
      const { series: _series, priority: _priority, id: _id, version, ...patch } = body;
      if (version !== undefined && version !== focusVersion(existing)) {
        json(res, { statusCode: 409, message: 'Focus block changed since it was read', error: 'Conflict', code: 'focus-block-stale' }, 409);
        return;
      }
      Object.assign(existing, patch, { version: focusVersion(existing) + 1 });
      json(res, focusResponse(existing, today));
      return;
    }

    // DELETE /focus/blocks/:id — also declines an auto-roll the block was covering
    if (method === 'DELETE' && parts[1] === 'blocks' && parts.length === 3) {
      const id = decodeURIComponent(parts[2]);
      const target = state.focusBlocks.find((b) => b.id === id);
      if (!target) {
        json(res, { statusCode: 404, message: 'Focus block not found' }, 404);
        return;
      }
      // Only the predecessors whose roll the deleted block was covering: owed without it,
      // not with it, as the API's owesRoll asks.
      const series = state.focusBlocks.filter((b) => b.series === target.series);
      const remaining = series.filter((b) => b.id !== id);
      for (const b of remaining) {
        if (owesRoll(b, remaining) && !owesRoll(b, series)) b.onEnd = 'prompt';
      }
      state.focusBlocks = state.focusBlocks.filter((b) => b.id !== id);
      noContent(res);
      return;
    }

    // GET /focus/settings
    if (method === 'GET' && parts[1] === 'settings') {
      json(res, state.focusGuide);
      return;
    }

    // PUT /focus/settings
    if (method === 'PUT' && parts[1] === 'settings') {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      state.focusGuide = { sets: body.sets, minutes: body.minutes };
      json(res, state.focusGuide);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // GET /lifts/metadata — every lift the user has stored metadata for (#1211). The mock
  // stores none, so every lift reads its built-in defaults (#1017).
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/lifts/metadata') {
    json(res, []);
    return;
  }

  // -------------------------------------------------------------------------
  // GET /lifts/:lift/metadata — like the real API (lift-metadata.controller.ts), any lift
  // gets a response: empty defaults when none is stored. Never a 404 (#1190).
  // -------------------------------------------------------------------------
  const metadataMatch = /^\/lifts\/([^/]+)\/metadata$/.exec(url.pathname);
  const emptyLiftMetadata = (lift) => ({
    lift,
    muscleGroups: [],
    secondaryMuscleGroups: [],
    substitutions: [],
    foundational: false,
    progression: null,
    progressionIncrement: null,
    repsLow: null,
    repsHigh: null,
  });
  if (method === 'GET' && metadataMatch) {
    json(res, emptyLiftMetadata(decodeURIComponent(metadataMatch[1])));
    return;
  }

  // PATCH /lifts/:lift/metadata — the import's Assign step saves a progression change (#1212).
  // Not stored: nothing in the mock reads it back.
  if (method === 'PATCH' && metadataMatch) {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    json(res, { ...emptyLiftMetadata(decodeURIComponent(metadataMatch[1])), ...body });
    return;
  }

  // -------------------------------------------------------------------------
  // GET /lifts/custom — list the user's custom lifts (#911)
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/lifts/custom') {
    json(res, state.customLifts);
    return;
  }

  // -------------------------------------------------------------------------
  // POST /lifts/custom — create a custom lift; 409 on a duplicate name (#911)
  // -------------------------------------------------------------------------
  if (method === 'POST' && url.pathname === '/lifts/custom') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    if (state.customLifts.some((l) => l.name === body.name)) {
      json(res, { statusCode: 409, message: `A lift named '${body.name}' already exists` }, 409);
      return;
    }
    const created = {
      id: `custom-${state.customLifts.length + 1}`,
      name: body.name,
      classification: body.classification,
      movementProfile: body.movementProfile ?? { patterns: [], jointActions: [], complexity: 'simple' },
      isBodyweightComponent: body.isBodyweightComponent ?? false,
      isCustom: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    state.customLifts.push(created);
    json(res, created, 201);
    return;
  }

  // -------------------------------------------------------------------------
  // GET /lifts/modifications?lift= — a lift's modifications, which the logger reads (#1152).
  // The mock doesn't resolve lifts, so every lift lists every modification.
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/lifts/modifications') {
    json(res, state.liftModifications);
    return;
  }

  // GET /lifts/modifications/by-lift?lift=&lift= — every lift's at once, keyed by the name asked
  // (#1242), which is how the logger loads them. Like the single form, each lift lists every one.
  if (method === 'GET' && url.pathname === '/lifts/modifications/by-lift') {
    json(res, Object.fromEntries(url.searchParams.getAll('lift').map((lift) => [lift, state.liftModifications])));
    return;
  }

  // -------------------------------------------------------------------------
  // POST /lifts/modifications — the logger's inline Add; 409 on a duplicate name (#1152)
  // -------------------------------------------------------------------------
  if (method === 'POST' && url.pathname === '/lifts/modifications') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    if (state.liftModifications.some((m) => m.name === body.name)) {
      json(res, { statusCode: 409, message: `${body.lift} already has a modification named '${body.name}'` }, 409);
      return;
    }
    const created = {
      id: `mod-${state.liftModifications.length + 1}`,
      lift: body.lift,
      name: body.name,
      description: body.description ?? '',
      maxMode: body.maxMode ?? 'none',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    state.liftModifications.push(created);
    json(res, created, 201);
    return;
  }

  // -------------------------------------------------------------------------
  // PATCH /lifts/modifications/:id — the lift editor's edit; 409 on a taken name (#1153)
  // -------------------------------------------------------------------------
  if (method === 'PATCH' && parts[0] === 'lifts' && parts[1] === 'modifications' && parts.length === 3) {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const found = state.liftModifications.find((m) => m.id === parts[2]);
    if (!found) {
      json(res, { statusCode: 404, message: 'Lift modification not found' }, 404);
      return;
    }
    if (body.name !== undefined && state.liftModifications.some((m) => m.id !== found.id && m.name === body.name)) {
      json(res, { statusCode: 409, message: `${found.lift} already has a modification named '${body.name}'` }, 409);
      return;
    }
    Object.assign(found, body);
    json(res, found);
    return;
  }

  // -------------------------------------------------------------------------
  // GET /focus/blocks/:id/summary — an ended focus block's totals (#1059)
  // -------------------------------------------------------------------------
  if (method === 'GET' && parts[0] === 'focus' && parts[1] === 'blocks' && parts.length === 4 && parts[3] === 'summary') {
    const block = state.focusBlocks.find((b) => b.id === parts[2]);
    if (!block) {
      json(res, { statusCode: 404, message: 'Focus block not found' }, 404);
      return;
    }
    const { start, end } = focusRange(block);
    json(res, {
      blockId: block.id,
      rangeStart: start,
      rangeEnd: end,
      sessions: 12,
      sets: 68,
      volume: 18340,
      prs: [{ lift: 'Hammer Curl', weight: 40, reps: 12, previousWeight: 35, previousReps: 12 }],
    });
    return;
  }

  // -------------------------------------------------------------------------
  // GET /users/me/export: the end-of-central-directory record alone is a valid empty zip.
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/users/me/export') {
    const emptyZip = Buffer.alloc(22);
    emptyZip.writeUInt32LE(0x06054b50, 0);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(emptyZip);
    return;
  }

  // -------------------------------------------------------------------------
  // Link a Google Sheet (#1433). Stands in for the API's OAuth routes: `authorize` returns a
  // Google URL for the spec to intercept, and the callback accepts only the code and state that
  // URL carries.
  // -------------------------------------------------------------------------
  if (url.pathname.startsWith('/integrations/google-sheet')) {
    const sheet = url.pathname.slice('/integrations/google-sheet'.length);
    if (method === 'GET' && sheet === '') {
      json(res, state.sheetLink);
      return;
    }
    if (!state.sheetLink.configured) {
      json(res, { statusCode: 503, error: 'google-sheet-unconfigured', message: 'Linking a Google Sheet is not set up here.' }, 503);
      return;
    }
    if (method === 'POST' && sheet === '/authorize') {
      json(res, { url: 'https://accounts.google.test/consent?state=mock-state' });
      return;
    }
    if (method === 'POST' && sheet === '/callback') {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      if (body.code !== 'mock-code' || body.state !== 'mock-state') {
        json(res, { statusCode: 400, error: 'google-sheet-state-invalid', message: 'This link attempt expired or is not yours. Try again.' }, 400);
        return;
      }
      state.sheetLink = { ...GOOGLE_SHEET_LINKED, lastMirroredAt: null };
      json(res, state.sheetLink);
      return;
    }
    if (method === 'DELETE' && sheet === '') {
      state.sheetLink = { configured: true, status: 'unlinked', spreadsheetUrl: null, lastMirroredAt: null, syncFailed: false };
      json(res, { revoked: true });
      return;
    }
    if (method === 'POST' && sheet === '/sync') {
      // The API's 409s name the link's state (#1444).
      if (state.sheetLink.status === 'needs_relink') {
        json(res, { statusCode: 409, error: 'google-sheet-needs-relink', message: 'Google access was removed. Link again.' }, 409);
        return;
      }
      if (state.sheetLink.status === 'sheet_missing') {
        json(res, { statusCode: 409, error: 'google-sheet-missing', message: 'The sheet was deleted or can’t be found.' }, 409);
        return;
      }
      if (state.sheetLink.status !== 'linked') {
        json(res, { statusCode: 409, error: 'google-sheet-not-linked', message: 'No Google Sheet is linked.' }, 409);
        return;
      }
      // The run finishes at once here: the mirror time moves and a failure clears.
      state.sheetLink = { ...state.sheetLink, lastMirroredAt: '2026-11-23T09:00:00.000Z', syncFailed: false };
      json(res, { queued: true }, 202);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Clear data and its backups (#1310). Clear refuses counts that differ from the stored ones,
  // as the API does, and leaves a 30-day backup.
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/users/me/training-data/counts') {
    json(res, state.trainingDataCounts);
    return;
  }
  if (method === 'POST' && url.pathname === '/users/me/training-data/clear') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    if (state.clearError) {
      json(res, { statusCode: 500, message: 'Couldn’t clear your training data.' }, 500);
      return;
    }
    if (JSON.stringify(body.counts) !== JSON.stringify(state.trainingDataCounts)) {
      json(res, { statusCode: 409, code: 'counts-changed', message: 'Your data has changed.', counts: state.trainingDataCounts }, 409);
      return;
    }
    const now = Date.now();
    const snapshot = {
      id: `snap-${state.snapshots.length + 1}`,
      kind: 'clear',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      counts: state.trainingDataCounts,
    };
    state.snapshots.unshift(snapshot);
    state.trainingDataCounts = { ...NO_TRAINING_DATA };
    json(res, { snapshot });
    return;
  }
  if (method === 'GET' && url.pathname === '/users/me/snapshots') {
    json(res, state.snapshots);
    return;
  }

  // -------------------------------------------------------------------------
  // GET /supplements (#1376): a small stack, product names and amounts only
  // -------------------------------------------------------------------------
  const supplementItem = (id, name, over = {}) => ({
    id, name, keyCompound: '', timing: '', shortNote: '', longNote: '', status: 'active',
    unverified: false, links: [], category: '', typicalRange: '', ingredients: [], doses: [], ...over,
  });
  const supplementStack = () => ({
    caffeineCutoff: '15:00',
    dayTypes: [
      { id: 'lift', name: 'Lift day', sessionTime: '16:30' },
      { id: 'rest', name: 'Rest day' },
    ],
    items: (state.supplementItems ??= supplementSeed()),
  });
  function supplementSeed() {
    const item = supplementItem;
    return [
      item('pre-x', 'Nutricost Pre-X', {
        keyCompound: '300 mg caffeine', timing: '30–60 min before',
        ingredients: [{ key: 'caffeine', amount: 300, unit: 'mg' }],
        doses: [{ slot: 'pre', amount: '1 scoop', servings: 1, dayTypes: ['lift'] }],
        reference: {
          uses: ['Alertness and focus before a hard session'],
          evidence: { level: 'strong', reason: 'Caffeine reliably improves performance.' },
          cautions: ['Can disturb sleep when taken late'],
          typicalRange: '3-6 mg/kg', sources: ['issn-caffeine'],
        },
      }),
      item('quest', 'Quest protein (vanilla milkshake)', {
        ingredients: [{ key: 'protein', amount: 24, unit: 'g' }],
        doses: [{ slot: 'post', amount: '1 scoop', servings: 1, dayTypes: ['lift'] }],
      }),
      item('glycine', 'Glycine', {
        doses: [{ slot: 'am', amount: '3 g', servings: 1, dayTypes: [] }],
      }),
      item('collagen', 'Hydrolyzed collagen peptides', {
        status: 'pending',
        doses: [{ slot: 'am', amount: '10 g', servings: 1, dayTypes: [] }],
      }),
    ];
  }

  if (method === 'GET' && url.pathname === '/supplements') {
    json(res, supplementStack());
    return;
  }

  // GET /supplements/changes, GET /supplements/as-of/:date and POST /supplements/items/:id/restore
  // (#1378): a change log kept in the mock's state, seeded with the stack's items added on Nov 18.
  // As-of is simplified: the current stack when the date is on or after the first change.
  const supplementChanges = () =>
    (state.supplementChanges ??= supplementSeed().map((item, i) => ({ seq: i + 1, date: '2026-11-18', type: 'added', item })));
  function supplementLog(type, body, date) {
    const log = supplementChanges();
    log.push({ seq: log.length + 1, date: date ?? '2026-11-21', type, ...body });
  }
  if (method === 'GET' && url.pathname === '/supplements/changes') {
    // The latest `limit` changes before `beforeSeq`, oldest first, as the API pages them.
    const beforeSeq = Number(url.searchParams.get('beforeSeq') ?? Infinity);
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const page = supplementChanges().filter((c) => c.seq < beforeSeq);
    json(res, structuredClone(page.slice(Math.max(0, page.length - limit))));
    return;
  }
  const asOfPath = url.pathname.match(/^\/supplements\/as-of\/(\d{4}-\d{2}-\d{2})$/);
  if (method === 'GET' && asOfPath) {
    const first = supplementChanges()[0].date;
    json(res, structuredClone({
      items: asOfPath[1] < first ? [] : supplementStack().items,
      dayTypes: supplementStack().dayTypes,
      firstChangeDate: first,
      anomalies: [],
    }));
    return;
  }
  const restorePath = url.pathname.match(/^\/supplements\/items\/([^/]+)\/restore$/);
  if (method === 'POST' && restorePath) {
    const id = decodeURIComponent(restorePath[1]);
    const stack = supplementStack();
    if (stack.items.some((i) => i.id === id)) {
      json(res, { statusCode: 409, message: `Supplement item ${id} is in the stack` }, 409);
      return;
    }
    const removed = supplementChanges().filter((c) => c.type === 'removed' && c.item.id === id).pop();
    if (!removed) {
      json(res, { statusCode: 404, message: `No removed supplement item ${id}` }, 404);
      return;
    }
    stack.items.push(structuredClone(removed.item));
    supplementLog('restored', { itemId: id }, url.searchParams.get('today'));
    json(res, stack);
    return;
  }

  // Tiers 2 and 3 (#1381). A name with "beetroot" in it matches a product label; any other name the
  // catalog lacks matches none, so the form offers Suggest with AI. The AI answers a name with
  // "tart cherry" in it and is off for every other name.
  if (method === 'POST' && url.pathname === '/supplements/label-lookup') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const name = String(body.name ?? '').toLowerCase();
    json(res, name.includes('beetroot') ? {
      status: 'ready',
      suggestions: [{
        name: 'Beetroot Powder', keyCompound: 'Beetroot', suggestedDose: '1 scoop (10 g)', timing: '', suggestedSlot: 'pre',
        typicalRange: '', ingredients: [{ key: 'beetroot', amount: 10, unit: 'g' }], productType: 'Botanical',
        sources: [{ label: 'NIH Dietary Supplement Label Database', url: 'https://dsld.od.nih.gov/label/1' }],
      }],
    } : { status: 'none' });
    return;
  }
  if (method === 'POST' && url.pathname === '/supplements/ai-suggestion') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const name = String(body.name ?? '').toLowerCase();
    json(res, name.includes('tart cherry') ? {
      status: 'ready',
      provider: 'Mock AI',
      suggestion: {
        name: 'Tart cherry extract', keyCompound: 'Anthocyanins', suggestedDose: '480 mg', timing: 'Evening',
        suggestedSlot: 'pm', typicalRange: '480-1000 mg', ingredients: [{ key: 'tart-cherry', amount: 480, unit: 'mg' }],
        productType: '', sources: [],
      },
    } : { status: 'off' });
    return;
  }

  // POST /supplements/catalog (#1409, #1458): one entry, enough to autofill a name typed as "creatine".
  if (method === 'POST' && url.pathname === '/supplements/catalog') {
    const body = await readBody(req);
    const q = (typeof body?.name === 'string' ? body.name : '').toLowerCase();
    json(res, q !== '' && 'creatine monohydrate'.includes(q) ? [{
      key: 'creatine-monohydrate', name: 'Creatine monohydrate', aliases: ['creatine'], kind: 'compound',
      keyCompound: 'Creatine monohydrate', suggestedDose: '5 g', timing: 'Anytime or pre-workout', suggestedSlot: 'am',
      ingredients: [{ key: 'creatine', amount: 5, unit: 'g' }],
      reference: { uses: ['Strength'], evidence: { level: 'strong', reason: 'Well studied.' }, cautions: [], typicalRange: '3-5 g', sources: [] },
    }] : []);
    return;
  }

  // POST /supplements/items, PATCH and DELETE /supplements/items/:id (#1409): kept in the mock's state.
  if (method === 'POST' && url.pathname === '/supplements/items') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const stack = supplementStack();
    const created = supplementItem(`supp-new-${(state.supplementNextId = (state.supplementNextId ?? 0) + 1)}`, body.name, body);
    stack.items.push(created);
    json(res, { ...stack, id: created.id }, 201);
    return;
  }
  const supplementPath = url.pathname.match(/^\/supplements\/items\/([^/]+)$/);
  if (supplementPath && (method === 'PATCH' || method === 'DELETE')) {
    const stack = supplementStack();
    const index = stack.items.findIndex((i) => i.id === decodeURIComponent(supplementPath[1]));
    if (index < 0) {
      json(res, { statusCode: 404, message: 'No such item' }, 404);
      return;
    }
    if (method === 'DELETE') {
      const [removed] = stack.items.splice(index, 1);
      supplementLog('removed', { item: removed }, url.searchParams.get('today'));
    }
    else {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      Object.assign(stack.items[index], body);
    }
    json(res, stack);
    return;
  }

  // POST /supplements/doses/move (#1410): the doses `doses` names, or the listed items' doses in
  // `from`, go to `to`.
  if (method === 'POST' && url.pathname === '/supplements/doses/move') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const stack = supplementStack();
    for (const item of stack.items.filter((i) => body.itemIds.includes(i.id))) {
      const named = body.doses?.filter((r) => r.itemId === item.id);
      const moves = (d, i) => (named ? named.some((r) => r.index === i && r.slot === d.slot) : d.slot === body.from);
      item.doses = item.doses.map((d, i) => (moves(d, i) ? { ...d, slot: body.to, dayTypes: body.dayTypes ?? d.dayTypes } : d));
    }
    json(res, stack);
    return;
  }

  // POST /supplements/items/remove (#1414): the listed items go in one write, or a 404 removes none.
  if (method === 'POST' && url.pathname === '/supplements/items/remove') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const stack = supplementStack();
    const unknown = body.itemIds.find((id) => !stack.items.some((i) => i.id === id));
    if (unknown !== undefined) {
      json(res, { statusCode: 404, message: `No supplement item ${unknown}` }, 404);
      return;
    }
    // Each one is logged as removed, for History's Restore (#1378).
    for (const item of stack.items.filter((i) => body.itemIds.includes(i.id))) {
      supplementLog('removed', { item }, url.searchParams.get('today'));
    }
    state.supplementItems = stack.items.filter((i) => !body.itemIds.includes(i.id));
    json(res, supplementStack());
    return;
  }

  // POST /supplements/import/google-sheet (#1379): a canned sheet, whatever the link. One tab has no
  // Compound column, as a lifter's workbook often does.
  if (method === 'POST' && url.pathname === '/supplements/import/google-sheet') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const tab = (name, rows) => ({ name, rows, links: rows.map((r) => r.map(() => '')), skipReason: null });
    json(res, {
      tabs: [
        tab('Notes', [['Date', 'Text'], ['11/1/2026', 'Started the stack']]),
        tab('Supplements', [
          ['Compound', 'Amount', 'Timing', 'Purpose', 'Notes'],
          ['Melatonin', '1-10mg', 'bedtime', 'sleep induction', 'more doesn’t induce sleep faster'],
          ['Iron', '18mg', 'anytime', 'red blood cells', ''],
          ['Nitrates', '???', '???', 'exercise agonist', ''],
        ]),
      ],
    });
    return;
  }

  // POST /supplements/import (#1379): the reviewed rows become items in one write, each logged as an
  // `added` change noted "Imported from <source>", as the API does, so History shows where they came from.
  if (method === 'POST' && url.pathname === '/supplements/import') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const stack = supplementStack();
    const dayTypeIds = stack.dayTypes.map((d) => d.id);
    for (const row of body.rows) {
      const created = supplementItem(`supp-new-${(state.supplementNextId = (state.supplementNextId ?? 0) + 1)}`, row.name, {
        timing: row.timing, shortNote: row.shortNote, longNote: row.longNote, links: row.links, status: row.status,
        ...(row.catalogKey === undefined ? {} : { catalogKey: row.catalogKey }),
        // A workout-slot dose takes every day type, as the API does.
        doses: row.doses.map((d) => (['pre', 'intra', 'post'].includes(d.slot) && d.dayTypes.length === 0 ? { ...d, dayTypes: dayTypeIds } : d)),
      });
      stack.items.push(created);
      supplementLog('added', { item: structuredClone(created), note: `Imported from ${body.source}` }, url.searchParams.get('today'));
    }
    json(res, supplementStack());
    return;
  }

  // POST /supplements/items/status (#1410, #1411): the listed items' status.
  if (method === 'POST' && url.pathname === '/supplements/items/status') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const stack = supplementStack();
    for (const item of stack.items.filter((i) => body.itemIds.includes(i.id))) item.status = body.status;
    json(res, stack);
    return;
  }

  // -------------------------------------------------------------------------
  // GET /users/me/settings
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/users/me/settings') {
    json(res, {
      activeProgram: state.activeProgram,
      workoutSchedule: state.workoutSchedule,
      defaultWeightIncrement: state.defaultWeightIncrement,
      unit: state.unit,
      defaultProgression: state.defaultProgression,
    });
    return;
  }

  // -------------------------------------------------------------------------
  // PATCH /users/me/settings
  // -------------------------------------------------------------------------
  if (method === 'PATCH' && url.pathname === '/users/me/settings') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    if ('workoutSchedule' in body) state.workoutSchedule = body.workoutSchedule;
    if ('defaultWeightIncrement' in body) state.defaultWeightIncrement = body.defaultWeightIncrement;
    if ('unit' in body) state.unit = body.unit;
    // Replaced whole, an omitted increment or range end stored as null, as the real API does (#1210).
    if ('defaultProgression' in body) {
      const d = body.defaultProgression;
      state.defaultProgression = d && {
        type: d.type,
        increment: d.increment ?? null,
        repsLow: d.repsLow ?? null,
        repsHigh: d.repsHigh ?? null,
      };
    }
    json(res, {
      activeProgram: state.activeProgram,
      workoutSchedule: state.workoutSchedule,
      defaultWeightIncrement: state.defaultWeightIncrement,
      unit: state.unit,
      defaultProgression: state.defaultProgression,
    });
    return;
  }

  // -------------------------------------------------------------------------
  // GET /users/me/recorded-programs (#1454, #1304): the programs holding sets or macrocycles. The
  // fixtures are 5-3-1's, and an Assign commit adds its program. The mock's custom ids aren't
  // UUIDs, so it leaves them out, as the pickers would never read a real custom id as a template.
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/users/me/recorded-programs') {
    const programs = new Set(['5-3-1']);
    if (state.assignedMacrocycles.length > 0) programs.add(state.assignedProgram);
    for (const p of state.customPrograms) programs.delete(p.id);
    json(res, [...programs].sort());
    return;
  }

  // -------------------------------------------------------------------------
  // GET /programs/custom
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/programs/custom') {
    json(res, state.customPrograms);
    return;
  }

  // -------------------------------------------------------------------------
  // POST /programs/custom — create a custom program (echoes the posted specs)
  // -------------------------------------------------------------------------
  if (method === 'POST' && url.pathname === '/programs/custom') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const created = {
      id: `cust-${state.customPrograms.length + 1}`,
      name: body.name ?? 'Custom Program',
      description: body.description ?? null,
      baseTemplate: body.baseTemplate ?? null,
      createdAt: '2026-01-01',
      specs: Array.isArray(body.specs) ? body.specs : [],
    };
    const { specs: _specs, ...summary } = created;
    state.customPrograms.push(summary);
    json(res, created, 201);
    return;
  }

  // -------------------------------------------------------------------------
  // PUT /programs/custom/:id — update a custom program (echoes the posted specs).
  // Declared before the generic /programs/:program/... block so :program is not
  // matched as "custom".
  // -------------------------------------------------------------------------
  if (method === 'PUT' && parts[0] === 'programs' && parts[1] === 'custom' && parts.length === 3) {
    const id = decodeURIComponent(parts[2]);
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    const existing = state.customPrograms.find((p) => p.id === id);
    const updated = {
      id,
      name: body.name ?? 'Custom Program',
      description: body.description ?? null,
      baseTemplate: body.baseTemplate ?? existing?.baseTemplate ?? null,
      createdAt: existing?.createdAt ?? '2026-01-01',
      specs: Array.isArray(body.specs) ? body.specs : [],
    };
    // Mirror POST: persist to state so a later GET /programs/custom reflects the
    // edit — an edit-mode e2e asserting a rename would otherwise pass on stale data.
    const { specs: _specs, ...summary } = updated;
    if (existing) Object.assign(existing, summary);
    else state.customPrograms.push(summary);
    json(res, updated);
    return;
  }

  // -------------------------------------------------------------------------
  // Program-scoped routes: /programs/:program/...
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // /non-cycle-workouts — training outside any program (#1184)
  // -------------------------------------------------------------------------
  if (parts[0] === 'non-cycle-workouts') {
    if (method === 'GET' && parts.length === 1) {
      json(res, state.nonCycleRecords.slice().sort((a, b) => b.date.localeCompare(a.date) || b.workoutNum - a.workoutNum));
      return;
    }
    if (method === 'POST' && parts.length === 1) {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      const workoutNum = Math.max(0, ...state.nonCycleRecords.map((r) => r.workoutNum)) + 1;
      const record = nonCycleRecord({ ...body, workoutNum });
      state.nonCycleRecords.push(record);
      json(res, nonCycleWorkout(workoutNum), 201);
      return;
    }
    const workout = parts.length === 2 ? nonCycleWorkout(Number(parts[1])) : null;
    if (!workout) {
      json(res, { statusCode: 404, message: 'Not found' }, 404);
      return;
    }
    if (method === 'GET') {
      json(res, workout);
      return;
    }
    if (method === 'DELETE') {
      state.nonCycleRecords = state.nonCycleRecords.filter((r) => r.workoutNum !== workout.workoutNum);
      noContent(res);
      return;
    }
  }

  if (parts[0] === 'programs' && parts[1] === 'non-cycle' && parts[2] === 'lift-records') {
    const body = await readBody(req);
    if (rejectIfInvalidBody(res, body)) return;
    if (method === 'POST' && parts.length === 3) {
      const record = nonCycleRecord(body);
      state.nonCycleRecords.push(record);
      json(res, record, 201);
      return;
    }
    const record = state.nonCycleRecords.find((r) => r.id === decodeURIComponent(parts[3] ?? ''));
    if (method === 'PATCH' && record) {
      Object.assign(record, body);
      json(res, record);
      return;
    }
    json(res, { statusCode: 404, message: 'Not found' }, 404);
    return;
  }

  if (parts[0] === 'programs' && parts.length >= 3) {
    const rest = parts.slice(2);

    // GET /programs/:p/non-cycle-reference?lift= (#1184): the lift's max, with no previous one.
    if (method === 'GET' && rest[0] === 'non-cycle-reference') {
      const lift = url.searchParams.get('lift') ?? '';
      const max = state.trainingMaxes.find((m) => m.lift.toLowerCase() === lift.toLowerCase());
      json(res, { lift, reference: max ? { trainingMax: max.weight, previous: null } : null });
      return;
    }

    // GET /programs/:p/macrocycles
    if (method === 'GET' && rest[0] === 'macrocycles' && rest.length === 1) {
      // An Assign commit's macrocycles come first by date, and the rest number on after them.
      // Each program lists its own: the fixtures are the active program's (#1300).
      const program = decodeURIComponent(parts[1]);
      const assigned = program === state.assignedProgram ? state.assignedMacrocycles : [];
      const fixtures = program === '5-3-1' ? MACROCYCLES : [];
      json(res, [...assigned, ...fixtures].map((m, i) => ({ ...m, macrocycleNum: i + 1 })));
      return;
    }

    // GET /programs/:p/import/batches (#1257): the imports History offers Undo for, or with
    // destination=training-maxes the one Settings offers Undo for (#1405).
    if (method === 'GET' && rest[0] === 'import' && rest[1] === 'batches' && rest.length === 2) {
      if (url.searchParams.get('destination') === 'training-maxes') {
        const tm = state.trainingMaxImport;
        json(res, tm && tm.batch.program === decodeURIComponent(parts[1]) ? [tm.batch] : []);
        return;
      }
      json(res, state.importBatches.filter((b) => b.program === decodeURIComponent(parts[1])));
      return;
    }

    // GET /programs/:p/macrocycles/current
    if (method === 'GET' && rest[0] === 'macrocycles' && rest[1] === 'current') {
      if (state.noCurrentMacrocycle) {
        json(res, { statusCode: 404, message: 'No active macrocycle' }, 404);
      } else {
        const dashboard = structuredClone(MACROCYCLE_DASHBOARD);
        for (const week of dashboard.weeks) {
          for (const wo of week.workouts) {
            wo.skipped = state.skippedWorkouts.has(wo.workoutNum);
          }
          week.completed = week.workouts.every((wo) => wo.skipped);
        }
        dashboard.skippedWorkoutNums = [...state.skippedWorkouts];
        json(res, dashboard);
      }
      return;
    }

    // POST /programs/:p/macrocycles/initialize
    if (method === 'POST' && rest[0] === 'macrocycles' && rest[1] === 'initialize') {
      json(res, MACROCYCLE_DASHBOARD);
      return;
    }

    // POST /programs/:p/macrocycles/current/redate (#1032): re-dates the current macrocycle by
    // the saved schedule from the lifter's `today`, or unschedules it when none is saved.
    if (method === 'POST' && rest[0] === 'macrocycles' && rest[1] === 'current' && rest[2] === 'redate') {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      if (typeof body.today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.today)) {
        json(res, { statusCode: 400, message: 'date must be a calendar date in YYYY-MM-DD format' }, 400);
        return;
      }
      if (state.noCurrentMacrocycle) {
        json(res, { macrocycleNum: null, scheduled: false, redated: 0, firstDate: null, kept: 0 });
        return;
      }
      const scheduled = state.workoutSchedule !== null;
      json(res, {
        macrocycleNum: 1,
        scheduled,
        redated: scheduled ? 5 : 0,
        firstDate: scheduled ? body.today : null,
        kept: 0,
      });
      return;
    }

    // GET /programs/:p/workouts/:workoutNum/focus?today=YYYY-MM-DD (#1058)
    if (method === 'GET' && rest[0] === 'workouts' && rest[2] === 'focus' && rest.length === 3) {
      const today = url.searchParams.get('today');
      if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
        json(res, { statusCode: 400, message: 'today must be an ISO date (YYYY-MM-DD)' }, 400);
        return;
      }
      if (state.focusError) {
        json(res, { statusCode: 500, message: 'Internal server error' }, 500);
        return;
      }
      const workoutNum = Number(rest[1]);
      // Focus blocks created through /focus/* (#1057) plan from those blocks; otherwise the
      // canned workout-details plan (#1058).
      json(
        res,
        state.focusBlocks.length > 0 ?
          planFromFocusBlocks(parts[1], workoutNum, today)
        : buildFocusPlan(workoutNum, today, state.focusDayStates.get(workoutNum) ?? emptyFocusDayState()),
      );
      return;
    }

    // GET /programs/:p/workouts/:workoutNum/focus-state (#1058)
    if (method === 'GET' && rest[0] === 'workouts' && rest[2] === 'focus-state' && rest.length === 3) {
      json(res, state.focusDayStates.get(Number(rest[1])) ?? emptyFocusDayState());
      return;
    }

    // PUT /programs/:p/workouts/:workoutNum/focus-state (#1058)
    if (method === 'PUT' && rest[0] === 'workouts' && rest[2] === 'focus-state' && rest.length === 3) {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      if (!isFocusDayState(body)) {
        json(res, { statusCode: 400, message: 'Invalid focus day state' }, 400);
        return;
      }
      state.focusDayStates.set(Number(rest[1]), body);
      json(res, body);
      return;
    }

    // GET /programs/:p/workouts/:workoutNum
    if (method === 'GET' && rest[0] === 'workouts' && rest.length === 2) {
      const workoutNum = Number(rest[1]);
      json(res, { ...WORKOUT, workoutNum, skipped: state.skippedWorkouts.has(workoutNum) });
      return;
    }

    // POST /programs/:p/macrocycles/:macrocycleNum/workouts/:workoutNum/skip
    if (method === 'POST' && rest[0] === 'macrocycles' && rest[2] === 'workouts' && rest[4] === 'skip') {
      const workoutNum = Number(rest[3]);
      state.skippedWorkouts.add(workoutNum);
      noContent(res);
      return;
    }

    // DELETE /programs/:p/macrocycles/:macrocycleNum/workouts/:workoutNum/skip
    if (method === 'DELETE' && rest[0] === 'macrocycles' && rest[2] === 'workouts' && rest[4] === 'skip') {
      const workoutNum = Number(rest[3]);
      state.skippedWorkouts.delete(workoutNum);
      noContent(res);
      return;
    }

    // GET /programs/:p/spec
    if (method === 'GET' && rest[0] === 'spec') {
      json(res, PROGRAM_SPEC);
      return;
    }

    // GET /programs/:p/modification-maxes — own maxes, which the logger re-plans from (#1153)
    // Like the API, only for modifications whose mode is own now.
    if (method === 'GET' && rest[0] === 'modification-maxes' && rest.length === 1) {
      const own = new Set(state.liftModifications.filter((m) => m.maxMode === 'own').map((m) => m.id));
      json(res, state.modificationMaxes.filter((m) => own.has(m.modificationId)));
      return;
    }

    // PUT /programs/:p/modification-maxes/:id — the lift editor sets an own max (#1153)
    if (method === 'PUT' && rest[0] === 'modification-maxes' && rest.length === 2) {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      const max = { modificationId: rest[1], weight: body.weight, unit: 'lbs', dateUpdated: '2026-01-01T00:00:00.000Z' };
      state.modificationMaxes = [...state.modificationMaxes.filter((m) => m.modificationId !== rest[1]), max];
      json(res, max);
      return;
    }

    // GET /programs/:p/training-maxes
    if (method === 'GET' && rest[0] === 'training-maxes' && rest.length === 1) {
      json(res, state.trainingMaxes);
      return;
    }

    // PATCH /programs/:p/training-maxes
    if (method === 'PATCH' && rest[0] === 'training-maxes' && rest.length === 1) {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      if (Array.isArray(body.maxes)) {
        const today = new Date().toISOString().split('T')[0];
        for (const update of body.maxes) {
          const existing = state.trainingMaxes.find((m) => m.lift === update.lift);
          if (existing) {
            existing.weight = update.weight;
            existing.unit = update.unit ?? existing.unit;
            existing.dateUpdated = today;
          } else {
            state.trainingMaxes.push({ lift: update.lift, weight: update.weight, unit: update.unit ?? 'lbs', dateUpdated: today });
          }
          // A lift with a max is no longer missing one (#1246).
          state.missingMaxes = state.missingMaxes.filter((m) => m.lift !== update.lift && m.liftId !== update.lift);
        }
      }
      json(res, state.trainingMaxes);
      return;
    }

    // GET /programs/:p/training-maxes/missing — lifts with sets and no max (#1246). `lifts`
    // narrows it by display name or id. As the real list does, it never reports a lift with a
    // max; the PATCH above also drops the entry once one is set.
    if (method === 'GET' && rest[0] === 'training-maxes' && rest[1] === 'missing' && rest.length === 2) {
      const wanted = url.searchParams.getAll('lifts');
      const missing = state.missingMaxes
        .filter((m) => !state.trainingMaxes.some((t) => t.lift === m.lift || t.lift === m.liftId))
        .filter((m) => wanted.length === 0 || wanted.includes(m.lift) || wanted.includes(m.liftId))
        .map((m) => ({ ...m, dismissed: state.missingMaxDismissals.has(m.liftId) }));
      json(res, missing);
      return;
    }

    // PUT / DELETE /programs/:p/training-maxes/missing/:liftId/dismissal (#1246)
    if (
      (method === 'PUT' || method === 'DELETE') &&
      rest[0] === 'training-maxes' &&
      rest[1] === 'missing' &&
      rest[3] === 'dismissal' &&
      rest.length === 4
    ) {
      const liftId = decodeURIComponent(rest[2]);
      if (method === 'PUT') state.missingMaxDismissals.add(liftId);
      else state.missingMaxDismissals.delete(liftId);
      noContent(res);
      return;
    }

    // GET /programs/:p/training-maxes/history
    if (method === 'GET' && rest[0] === 'training-maxes' && rest[1] === 'history') {
      json(res, TM_HISTORY);
      return;
    }

    // GET /programs/:p/lift-records
    if (method === 'GET' && rest[0] === 'lift-records' && rest.length === 1) {
      json(res, LIFT_RECORDS);
      return;
    }

    // POST /programs/:p/lift-records
    if (method === 'POST' && rest[0] === 'lift-records' && rest.length === 1) {
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      // A set names its modifications as { id, name }, as the API's response does (#1152).
      const { modifications, ...fields } = body;
      const named = (modifications ?? []).map((id) => ({
        id,
        name: state.liftModifications.find((m) => m.id === id)?.name ?? id,
      }));
      const record = { id: `r-${Date.now()}`, ...fields, ...(named.length > 0 && { modifications: named }) };
      json(res, record, 201);
      return;
    }

    // GET /programs/:p/strength-goals
    if (method === 'GET' && rest[0] === 'strength-goals' && rest.length === 1) {
      json(res, state.strengthGoals);
      return;
    }

    // PUT /programs/:p/strength-goals/:lift
    if (method === 'PUT' && rest[0] === 'strength-goals' && rest.length === 2) {
      const lift = decodeURIComponent(rest[1]);
      const body = await readBody(req);
      if (rejectIfInvalidBody(res, body)) return;
      const goal = { lift, ...body, updatedAt: new Date().toISOString() };
      const idx = state.strengthGoals.findIndex((g) => g.lift === lift);
      if (idx >= 0) {
        state.strengthGoals[idx] = goal;
      } else {
        state.strengthGoals.push(goal);
      }
      json(res, goal);
      return;
    }

    // DELETE /programs/:p/strength-goals/:lift
    if (method === 'DELETE' && rest[0] === 'strength-goals' && rest.length === 2) {
      const lift = decodeURIComponent(rest[1]);
      state.strengthGoals = state.strengthGoals.filter((g) => g.lift !== lift);
      noContent(res);
      return;
    }

    // GET /programs/:p/body-weight/latest
    if (method === 'GET' && rest[0] === 'body-weight' && rest[1] === 'latest') {
      json(res, { statusCode: 404, message: 'Not found' }, 404);
      return;
    }

    // POST /programs/:p/body-weight
    if (method === 'POST' && rest[0] === 'body-weight' && rest.length === 1) {
      noContent(res);
      return;
    }

    // POST /programs/:p/switch
    if (method === 'POST' && rest[0] === 'switch') {
      state.activeProgram = decodeURIComponent(parts[1]);
      json(res, { activeProgram: state.activeProgram, macrocycleNum: 1 });
      return;
    }

    // GET /programs/:p/lifts
    if (method === 'GET' && rest[0] === 'lifts' && rest.length === 1) {
      json(res, ['squat', 'bench-press', 'deadlift', 'overhead-press', 'barbell-row']);
      return;
    }

    // POST /programs/:p/import?mode=preview|commit|dry-run[&destination=]
    // Canned Smart Import response (#477) — classifies any upload as training-maxes,
    // unless withAmbiguousLift opted the mock into the #911 lift-records remap flow.
    if (method === 'POST' && rest[0] === 'import' && rest.length === 1) {
      const mode = url.searchParams.get('mode') ?? 'preview';
      const destination = url.searchParams.get('destination') ?? 'training-maxes';

      if (state.goalSpellingCollision) {
        // A form field, so the Playwright keep flow proves the client sends it where the real
        // API reads it: on the preview that moves the row, and on the commit that stores it.
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const form = await new Response(Buffer.concat(chunks), {
          headers: { 'content-type': req.headers['content-type'] },
        }).formData();
        const kept = JSON.parse(form.get('liftOverrides') ?? '{}')['1'];
        if (mode === 'commit' || mode === 'dry-run') {
          json(res, { destination: 'strength-goals', created: kept ? 2 : 1, updated: 0, skipped: kept ? 0 : 1, errors: [], batchId: 'batch-1' });
          return;
        }
        json(res, {
          classification: { type: 'strength-goals', confidence: 0.95, bucket: 'high', reasons: ['Matched the goal tiers'], alternatives: [] },
          destination: 'strength-goals',
          preview: {
            creates: 2,
            updates: 0,
            skips: 0,
            unresolved: 0,
            deltas: [
              kept
                ? { key: kept, label: state.customLifts.find((l) => l.id === kept)?.name ?? kept, kind: 'create', after: '350 lbs', rowIndex: 1 }
                : { key: 'back-squat', label: 'Back Squat', kind: 'create', after: '350 lbs', rowIndex: 1 },
              { key: 'Back Squat', label: 'Back Squat', kind: 'create', after: '400 lbs', rowIndex: 2 },
            ],
            ...(kept
              ? {}
              : {
                  goalSpellingCollisions: [
                    {
                      key: 'back-squat',
                      label: 'Back Squat',
                      rows: [
                        { spelling: 'Squat', lift: 'back-squat', value: '350 lbs', rowIndexes: [1] },
                        { spelling: 'Back Squat', lift: 'Back Squat', value: '400 lbs', rowIndexes: [2] },
                      ],
                    },
                  ],
                }),
          },
          errors: [],
        });
        return;
      }

      if (state.ambiguousLift && destination === 'lift-records') {
        if (mode === 'commit' || mode === 'dry-run') {
          // A form field since #1121, so the Playwright remap flow proves the client
          // sends it where the real API reads it.
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const form = await new Response(Buffer.concat(chunks), {
            headers: { 'content-type': req.headers['content-type'] },
          }).formData();
          const liftOverridesField = form.get('liftOverrides');
          const liftOverrides = liftOverridesField ? JSON.parse(liftOverridesField) : {};
          // Derived from AMBIGUOUS_LIFT_ROWS (the same list the preview branch
          // below returns), not a hardcoded row count — growing that fixture no
          // longer requires a matching hand-edit here (#911 review). Mirrors the
          // real strict validator's all-or-nothing semantics: resolves only once
          // every ambiguous row has a remap.
          const allResolved = AMBIGUOUS_LIFT_ROWS.every(
            (row) => liftOverrides[String(row.rowIndex)],
          );
          const created = allResolved ? AMBIGUOUS_LIFT_ROWS.length : 0;
          // The lifts the commit wrote (#1273). A committed one has sets and no max, so the
          // missing list reports it, as the real one would: `lift` as its sets store it (a custom
          // lift's id) and `name` to show (#1290).
          const lifts = mode === 'commit' && created > 0 ? [...new Set(Object.values(liftOverrides))] : [];
          for (const liftId of lifts) {
            if (state.missingMaxes.some((m) => m.liftId === liftId)) continue;
            state.missingMaxes.push({
              lift: liftId,
              name: state.customLifts.find((l) => l.id === liftId)?.name ?? liftId,
              liftId,
              lastLoggedDate: '2026-01-01',
              setCount: AMBIGUOUS_LIFT_ROWS.filter((row) => liftOverrides[String(row.rowIndex)] === liftId).length,
              // core's estimate from the best set, 90 × 10: Brzycki's 120, then 90% floored to 2.5.
              estimate: { weight: 107.5, unit: 'lbs', from: { date: '2026-01-01', weight: 90, reps: 10 } },
            });
          }
          json(res, {
            destination,
            created,
            updated: 0,
            skipped: 0,
            errors: [],
            batchId: created > 0 ? 'batch-ambiguous-lift' : null,
            ...(mode === 'commit' && { lifts }),
          });
        } else {
          // The user explicitly picked "Lift History" from the manual destination
          // picker (handlePickDestination) — return the real lift-records preview,
          // with two ambiguous rows sharing one unrecognized name (#911's own
          // motivating scenario: one recurring name, many set rows).
          json(res, {
            classification: {
              type: 'lift-records',
              confidence: 0.45,
              bucket: 'low',
              reasons: [],
              alternatives: [],
            },
            destination: 'lift-records',
            columnMappings: [
              { sourceHeader: 'Program', destinationField: 'program', confidence: 1, required: true },
              { sourceHeader: 'Cycle #', destinationField: 'macrocycleNum', confidence: 1, required: true },
              { sourceHeader: 'Workout #', destinationField: 'workoutNum', confidence: 1, required: true },
              { sourceHeader: 'Date', destinationField: 'date', confidence: 1, required: true },
              { sourceHeader: 'Lift', destinationField: 'lift', confidence: 1, required: true },
              { sourceHeader: 'Set #', destinationField: 'setNum', confidence: 1, required: true },
              { sourceHeader: 'Weight', destinationField: 'weight', confidence: 1, required: true },
              { sourceHeader: 'Reps', destinationField: 'reps', confidence: 1, required: true },
            ],
            preview: {
              creates: 0,
              updates: 0,
              skips: 0,
              unresolved: AMBIGUOUS_LIFT_ROWS.length,
              deltas: AMBIGUOUS_LIFT_ROWS.map((row) => ({
                key: `__ambiguous_${row.rowIndex}`,
                label: `Row ${row.rowIndex}: ${row.originalLift}`,
                kind: 'create',
                status: 'ambiguous',
                rowIndex: row.rowIndex,
                originalLift: row.originalLift,
              })),
            },
            errors: [],
          });
        }
        return;
      }
      if (state.ambiguousLift && mode === 'preview' && !url.searchParams.get('destination')) {
        // Initial classify pass (no destination override yet): low-confidence, so the
        // frontend renders the manual destination picker (mirrors the block above).
        json(res, {
          classification: {
            type: null,
            confidence: 0.4,
            bucket: 'low',
            reasons: [],
            alternatives: [{ type: 'lift-records', confidence: 0.45, closeCall: false }],
          },
          destination: null,
          columnMappings: null,
          preview: null,
          errors: [],
        });
        return;
      }

      // A Google Sheets lift-history tab is previewed with an explicit destination (#1111).
      if (state.googleSheet && mode === 'preview' && url.searchParams.get('destination') === 'lift-records') {
        json(res, {
          classification: { type: 'lift-records', confidence: 0.95, bucket: 'high', reasons: [], alternatives: [] },
          destination: 'lift-records',
          columnMappings: SHEET_LIFT_RECORD_MAPPINGS,
          preview: {
            creates: 2,
            updates: 0,
            skips: 0,
            unresolved: 0,
            deltas: [
              { key: '38:1:20251229:bench-press:1', label: 'bench-press', kind: 'create', after: '180 × 8' },
              { key: '38:1:20251229:bench-press:2', label: 'bench-press', kind: 'create', after: '170 × 7' },
            ],
          },
          errors: [],
        });
        return;
      }

      if (state.assign && mode === 'assign') {
        json(res, state.continueOffer ? { ...ASSIGN_RESPONSE, continue: CONTINUE_OFFER } : ASSIGN_RESPONSE);
        return;
      }
      if (state.assign && mode === 'preview') {
        json(res, ASSIGN_PREVIEW);
        return;
      }
      // An Assign commit stores the first two stretches as macrocycles, under one batch (#1257).
      if (state.assign && mode === 'commit') {
        state.assignedProgram = decodeURIComponent(parts[1]);
        state.assignedMacrocycles = ASSIGN_RESPONSE.stretches.slice(0, 2).map((s, i) => ({
          id: `mc-assigned-${i + 1}`,
          macrocycleNum: 0,
          startDate: s.startDate,
          endDate: s.endDate,
          status: 'completed',
          origin: 'imported',
          current: false,
          unmatched: false,
        }));
        state.importBatches = [
          {
            id: 'batch-assign',
            program: decodeURIComponent(parts[1]),
            createdAt: new Date().toISOString(),
            macrocycleIds: state.assignedMacrocycles.map((m) => m.id),
          },
        ];
        json(res, { destination: 'lift-records', created: 36, updated: 0, skipped: 0, errors: [], batchId: 'batch-assign' });
        return;
      }

      if (mode === 'commit' || mode === 'dry-run') {
        // batchId enables the Phase 3 undo flow.
        json(res, { destination, created: 2, updated: 1, skipped: 0, errors: [], batchId: 'batch-1' });
      } else {
        json(res, {
          classification: {
            type: 'training-maxes',
            confidence: 0.95,
            bucket: 'high',
            reasons: ['Matched 4/4 expected columns (Date Updated, Lift, Weight)'],
            alternatives: [{ type: 'lift-records', confidence: 0.42, closeCall: false }],
          },
          destination: 'training-maxes',
          // When nonStandardColumns is set, include fuzzy column mappings with one
          // required field unmapped so the MAP_COLUMNS override flow can be tested.
          // Omitted in the standard case (not empty array) to preserve the mock
          // contract the existing first import test relies on.
          ...(state.nonStandardColumns
            ? {
                columnMappings: [
                  { sourceHeader: 'Date', destinationField: 'dateUpdated', confidence: 0.65, required: true, transformationNote: null },
                  // `fuzzyColumnMapper` never marks an unmatched source column required: it
                  // reports the field the file lacks as a row of its own, which is where the
                  // wizard asks which column holds it (#1442).
                  { sourceHeader: 'Exercise', destinationField: '', confidence: 0.0, required: false, transformationNote: 'No matching field found' },
                  { sourceHeader: 'Max Weight', destinationField: 'weight', confidence: 0.72, required: true, transformationNote: null },
                  { sourceHeader: '', destinationField: 'lift', confidence: 0, required: true, transformationNote: 'Required field not found in CSV' },
                ],
              }
            : {}),
          preview: {
            creates: 2,
            updates: state.spellingCollision ? 0 : 1,
            skips: 0,
            unresolved: 0,
            deltas: state.spellingCollision
              ? [
                  // `Squat` stores as back-squat, and the slot map leaves `Back Squat` as written.
                  { key: 'back-squat', label: 'Back Squat', kind: 'create', after: '300' },
                  { key: 'Back Squat', label: 'Back Squat', kind: 'create', after: '320' },
                ]
              : [
                  { key: 'squat', label: 'squat', kind: 'create', after: '300' },
                  { key: 'bench-press', label: 'bench-press', kind: 'update', before: '200', after: '210' },
                ],
            ...(state.spellingCollision
              ? {
                  spellingCollisions: [
                    {
                      key: 'back-squat',
                      label: 'Back Squat',
                      rows: [
                        { spelling: 'Back Squat', lift: 'Back Squat', weight: 320, dateUpdated: '2026-01-01' },
                        { spelling: 'Squat', lift: 'back-squat', weight: 300, dateUpdated: '2025-01-01' },
                      ],
                    },
                  ],
                }
              : {}),
          },
          errors: [],
        });
      }
      return;
    }
    // POST /programs/:p/import/google-sheet — canned two-tab workbook (#1111).
    // Mirrors the real endpoint's failures: 400 for a link that is not a Google
    // Sheet, 422 (with withPrivateSheet) for a sheet that is not link-shared.
    if (method === 'POST' && rest[0] === 'import' && rest[1] === 'google-sheet' && rest.length === 2) {
      const body = await readBody(req);
      if (!String(body?.url ?? '').includes('docs.google.com/spreadsheets/d/')) {
        json(res, { statusCode: 400, message: 'Only Google Sheets links (docs.google.com) can be imported.', error: 'Bad Request' }, 400);
        return;
      }
      if (state.privateSheet) {
        json(
          res,
          {
            statusCode: 422,
            message:
              'This sheet is not shared. In Google Sheets, click Share and set General access to "Anyone with the link" (Viewer), then try again.',
            error: 'Unprocessable Entity',
          },
          422,
        );
        return;
      }
      json(res, {
        tabs: [
          {
            name: 'TOC',
            rowCount: 3,
            classification: { type: null, confidence: 0.1, bucket: 'low', reasons: [], alternatives: [] },
            suggestedKind: null,
            csv: null,
            skipReason: 'Not recognized as lift history, training maxes, strength goals or a program.',
          },
          {
            name: 'LIFT_RECORDS',
            rowCount: 3,
            classification: { type: 'lift-records', confidence: 0.95, bucket: 'high', reasons: [], alternatives: [] },
            suggestedKind: 'lift-records',
            csv: 'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes\nRPT,38,1,12/29/2025,Bench P.,1,180,8,\nRPT,38,1,12/29/2025,Bench P.,2,170,7,',
            skipReason: null,
          },
          {
            name: 'TRAINING_MAXES',
            rowCount: 3,
            classification: { type: 'training-maxes', confidence: 0.95, bucket: 'high', reasons: [], alternatives: [] },
            suggestedKind: 'training-maxes',
            csv: 'Date Updated,Lift,Weight\n9/25/2026,Squat,300\n9/25/2026,Bench P.,210',
            skipReason: null,
          },
        ],
      });
      return;
    }
    // POST /programs/:p/import/:batchId/undo — Phase 3 undo
    if (method === 'POST' && rest[0] === 'import' && rest.length === 3 && rest[2] === 'undo') {
      // Undoing the seeded training-maxes import puts back the max it raised (#1405).
      const tm = state.trainingMaxImport;
      if (tm && tm.batch.id === rest[1]) {
        state.trainingMaxes.find((m) => m.lift === tm.lift).weight = tm.before;
        state.trainingMaxImport = null;
        json(res, { batchId: rest[1], restored: 1, skipped: 0, flagged: [] });
        return;
      }
      // Undoing a recorded batch removes its macrocycles (#1257).
      const batch = state.importBatches.find((b) => b.id === rest[1]);
      if (batch) {
        state.assignedMacrocycles = state.assignedMacrocycles.filter((m) => !batch.macrocycleIds.includes(m.id));
        state.importBatches = state.importBatches.filter((b) => b !== batch);
      }
      json(res, { batchId: rest[1], restored: 2, skipped: 0, flagged: [] });
      return;
    }
  }

  // 404 fallback
  console.warn(`[mock-api] Unhandled: ${method} ${url.pathname}`);
  json(res, { statusCode: 404, message: `Not found: ${method} ${url.pathname}` }, 404);
});

// Port defaults to 3004 (what playwright.config expects); overridable via MOCK_API_PORT so a
// unit test can spawn an isolated instance without colliding with a running Playwright/dev mock.
const PORT = Number(process.env.MOCK_API_PORT) || 3004;
// Bind explicitly to 127.0.0.1 (IPv4 loopback) rather than the default all-interfaces
// address: on Windows the default bind is non-deterministic (sometimes ::1-only), so a
// client dialing 127.0.0.1 can get ECONNREFUSED. Pinning the bind and every client to
// 127.0.0.1 keeps them in agreement on every platform. See CLAUDE.md / issue #741.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-api] Listening on http://127.0.0.1:${PORT}`);
});
