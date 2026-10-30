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

// ---------------------------------------------------------------------------
// In-memory state (reset between tests via GET /__reset)
// ---------------------------------------------------------------------------

const CUSTOM_PROGRAM = {
  id: 'cust-1',
  name: 'My Custom Program',
  description: null,
  baseTemplate: null,
  createdAt: '2026-01-01',
};

function createInitialState() {
  return {
    noCurrentMacrocycle: false,
    trainingMaxes: structuredClone(INITIAL_TRAINING_MAXES),
    strengthGoals: [],
    skippedWorkouts: new Set(),
    workoutSchedule: null,
    defaultWeightIncrement: null,
    unit: null,
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
    // GET/POST /lifts/custom (#911) — a user's custom lifts.
    customLifts: [],
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

function focusResponse(block, today) {
  const { start, end } = focusRange(block);
  return { ...block, status: focusStatus(block, today), rangeStart: start, rangeEnd: end };
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
    prescription: { progression: 'double', sets: entry.sets, repsLow: entry.repsLow, repsHigh: entry.repsHigh, weight: entry.weight, lastReps: null },
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
      const created = { ...body, id, series: body.series ?? id, priority };
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
      const { series: _series, priority: _priority, id: _id, ...patch } = body;
      Object.assign(existing, patch);
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
  // GET /users/me/settings
  // -------------------------------------------------------------------------
  if (method === 'GET' && url.pathname === '/users/me/settings') {
    json(res, {
      activeProgram: '5-3-1',
      workoutSchedule: state.workoutSchedule,
      defaultWeightIncrement: state.defaultWeightIncrement,
      unit: state.unit,
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
    json(res, {
      activeProgram: '5-3-1',
      workoutSchedule: state.workoutSchedule,
      defaultWeightIncrement: state.defaultWeightIncrement,
      unit: state.unit,
    });
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
  if (parts[0] === 'programs' && parts.length >= 3) {
    const rest = parts.slice(2);

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
        }
      }
      json(res, state.trainingMaxes);
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
      const record = { id: `r-${Date.now()}`, ...body };
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
      json(res, { activeProgram: parts[1], macrocycleNum: 1 });
      return;
    }

    // GET /programs/:p/lifts
    if (method === 'GET' && rest[0] === 'lifts' && rest.length === 1) {
      json(res, ['squat', 'bench-press', 'deadlift', 'overhead-press', 'barbell-row']);
      return;
    }

    // POST /programs/:p/import?mode=preview|commit[&destination=]
    // Canned Smart Import response (#477) — classifies any upload as training-maxes,
    // unless withAmbiguousLift opted the mock into the #911 lift-records remap flow.
    if (method === 'POST' && rest[0] === 'import' && rest.length === 1) {
      const mode = url.searchParams.get('mode') ?? 'preview';
      const destination = url.searchParams.get('destination') ?? 'training-maxes';

      if (state.ambiguousLift && destination === 'lift-records') {
        if (mode === 'commit') {
          const liftOverridesParam = url.searchParams.get('liftOverrides');
          const liftOverrides = liftOverridesParam ? JSON.parse(liftOverridesParam) : {};
          // Derived from AMBIGUOUS_LIFT_ROWS (the same list the preview branch
          // below returns), not a hardcoded row count — growing that fixture no
          // longer requires a matching hand-edit here (#911 review). Mirrors the
          // real strict validator's all-or-nothing semantics: resolves only once
          // every ambiguous row has a remap.
          const allResolved = AMBIGUOUS_LIFT_ROWS.every(
            (row) => liftOverrides[String(row.rowIndex)],
          );
          const created = allResolved ? AMBIGUOUS_LIFT_ROWS.length : 0;
          json(res, {
            destination,
            created,
            updated: 0,
            skipped: 0,
            errors: [],
            batchId: created > 0 ? 'batch-ambiguous-lift' : null,
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

      if (mode === 'commit') {
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
                  { sourceHeader: 'Exercise', destinationField: '', confidence: 0.0, required: true, transformationNote: null },
                  { sourceHeader: 'Max Weight', destinationField: 'weight', confidence: 0.72, required: true, transformationNote: null },
                ],
              }
            : {}),
          preview: {
            creates: 2,
            updates: 1,
            skips: 0,
            deltas: [
              { key: 'squat', label: 'squat', kind: 'create', after: '300' },
              { key: 'bench-press', label: 'bench-press', kind: 'update', before: '200', after: '210' },
            ],
          },
          errors: [],
        });
      }
      return;
    }
    // POST /programs/:p/import/:batchId/undo — Phase 3 undo
    if (method === 'POST' && rest[0] === 'import' && rest.length === 3 && rest[2] === 'undo') {
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
