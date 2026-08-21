// Lightweight mock API server for Playwright E2E tests.
// Started by playwright.config.ts via webServer; Next.js is pointed at it via API_URL.
// No npm dependencies — plain Node.js http module only.
import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// Canned data
// ---------------------------------------------------------------------------

const CYCLE_DASHBOARD = {
  program: '5-3-1',
  cycleNum: 1,
  cycleStartDate: '2025-01-06',
  currentWeekType: 'regular',
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
  // Top-level per-workout metadata the Cycle Dashboard reads instead of a
  // per-workout fetch (issue #740). skippedWorkoutNums is filled from state below.
  dateOverrides: {},
  skippedWorkoutNums: [],
  completedWorkoutNums: [],
};

const WORKOUT = {
  program: '5-3-1',
  cycleNum: 1,
  workoutNum: 1,
  week: 1,
  date: '2025-01-06',
  skipped: false,
  lifts: [
    {
      lift: 'squat',
      planned: true,
      sets: [
        { setNum: 1, weight: 195, reps: 5, amrap: false },
        { setNum: 2, weight: 225, reps: 5, amrap: false },
        { setNum: 3, weight: 255, reps: 5, amrap: true },
      ],
    },
    {
      lift: 'deadlift',
      planned: true,
      sets: [
        { setNum: 1, weight: 230, reps: 5, amrap: false },
        { setNum: 2, weight: 265, reps: 5, amrap: false },
        { setNum: 3, weight: 300, reps: 5, amrap: true },
      ],
    },
  ],
};

const PROGRAM_SPEC = [
  { week: 1, lift: 'squat', order: 1, offset: 0, increment: 5, sets: 3, reps: 5, amrap: true, warmUpPct: '0.4,0.5,0.6', wtDecrementPct: 0, activation: 'none' },
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
  { id: 'r1', program: '5-3-1', cycleNum: 1, workoutNum: 1, date: '2025-01-06', lift: 'squat', setNum: 1, weight: 195, reps: 5, notes: '' },
  { id: 'r2', program: '5-3-1', cycleNum: 1, workoutNum: 1, date: '2025-01-06', lift: 'deadlift', setNum: 1, weight: 230, reps: 5, notes: '' },
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
    noCurrentCycle: false,
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
  };
}

let state = createInitialState();

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
  // GET /__reset?noCurrentCycle=true — reset with no active cycle
  // -------------------------------------------------------------------------
  if (url.pathname === '/__reset') {
    state = createInitialState();
    if (url.searchParams.get('noCurrentCycle') === 'true') {
      state.noCurrentCycle = true;
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
    json(res, { ok: true });
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

    // GET /programs/:p/cycles/current
    if (method === 'GET' && rest[0] === 'cycles' && rest[1] === 'current') {
      if (state.noCurrentCycle) {
        json(res, { statusCode: 404, message: 'No active cycle' }, 404);
      } else {
        const dashboard = structuredClone(CYCLE_DASHBOARD);
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

    // POST /programs/:p/cycles/initialize
    if (method === 'POST' && rest[0] === 'cycles' && rest[1] === 'initialize') {
      json(res, CYCLE_DASHBOARD);
      return;
    }

    // GET /programs/:p/workouts/:workoutNum
    if (method === 'GET' && rest[0] === 'workouts' && rest.length === 2) {
      const workoutNum = Number(rest[1]);
      json(res, { ...WORKOUT, workoutNum, skipped: state.skippedWorkouts.has(workoutNum) });
      return;
    }

    // POST /programs/:p/cycles/:cycleNum/workouts/:workoutNum/skip
    if (method === 'POST' && rest[0] === 'cycles' && rest[2] === 'workouts' && rest[4] === 'skip') {
      const workoutNum = Number(rest[3]);
      state.skippedWorkouts.add(workoutNum);
      noContent(res);
      return;
    }

    // DELETE /programs/:p/cycles/:cycleNum/workouts/:workoutNum/skip
    if (method === 'DELETE' && rest[0] === 'cycles' && rest[2] === 'workouts' && rest[4] === 'skip') {
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
      json(res, { activeProgram: parts[1], cycleNum: 1 });
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
          // Both rows resolve only once every ambiguous row has a remap — mirrors the
          // real strict validator's all-or-nothing semantics closely enough for this test.
          const created = liftOverrides['1'] && liftOverrides['2'] ? 2 : 0;
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
              { sourceHeader: 'Cycle #', destinationField: 'cycleNum', confidence: 1, required: true },
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
              deltas: [
                {
                  key: '__ambiguous_1',
                  label: 'Row 1: Wide-Grip CBL Curls',
                  kind: 'create',
                  status: 'ambiguous',
                  rowIndex: 1,
                  originalLift: 'Wide-Grip CBL Curls',
                },
                {
                  key: '__ambiguous_2',
                  label: 'Row 2: Wide-Grip CBL Curls',
                  kind: 'create',
                  status: 'ambiguous',
                  rowIndex: 2,
                  originalLift: 'Wide-Grip CBL Curls',
                },
              ],
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
