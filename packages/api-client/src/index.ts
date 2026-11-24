import type {
  GoogleSheetLinkView,
  GoogleSheetUnlinkResult,
  BodyWeightResponse,
  CreateCustomLiftRequest,
  CreateFocusBlockRequest,
  CreateCustomProgramRequest,
  CreateLiftModificationRequest,
  CreateLiftOverrideRequest,
  CreateLiftRecordRequest,
  CreateNonCycleWorkoutRequest,
  CustomLiftResponse,
  CustomProgramResponse,
  CustomProgramSummaryResponse,
  ClearTrainingDataResponse,
  DataSnapshotSummary,
  FocusBlockResponse,
  FocusBlockSummaryResponse,
  FocusDayPlanResponse,
  FocusDayState,
  FocusSettingsResponse,
  ReorderFocusBlocksRequest,
  MacrocycleDashboardResponse,
  ImportAssignResponse,
  ImportOverwriteCounts,
  ImportOverwriteCountsResponse,
  ImportOverwriteRangeCountsResponse,
  ImportBreakdown,
  ImportSuggestionsResponse,
  ImportCommitResponse,
  ImportDryRunResponse,
  ImportError,
  ImportKind,
  ImportLiftRecordsResponse,
  GoogleSheetImportRequest,
  GoogleSheetWorkbookResponse,
  ImportPreviewResponse,
  ImportBatchSummary,
  ImportUndoResponse,
  TrainingMaxImportBatchSummary,
  LiftMetadataResponse,
  LiftModificationResponse,
  LiftModificationsByLiftResponse,
  LiftOverrideResponse,
  LiftingProgramSpecResponse,
  LiftRecordExportPartsResponse,
  LiftRecordExportQuery,
  LiftRecordResponse,
  MacrocycleSummaryResponse,
  ModificationMaxResponse,
  NonCycleReferenceResponse,
  NonCycleWorkoutResponse,
  PatchLiftMetadataRequest,
  PutModificationMaxRequest,
  RecordBodyWeightRequest,
  RedateMacrocycleResponse,
  RescheduleRequest,
  RestoreSnapshotResponse,
  StrengthGoalResponse,
  SwitchProgramResponse,
  MissingTrainingMaxResponse,
  TrainingDataCounts,
  TrainingMaxHistoryResponse,
  TrainingMaxResponse,
  UpdateCustomProgramRequest,
  UpdateFocusBlockRequest,
  UpdateFocusSettingsRequest,
  UpdateLiftModificationRequest,
  UpdateLiftRecordRequest,
  UpdateTrainingMaxesRequest,
  UpdateUserSettingsRequest,
  UpsertStrengthGoalRequest,
  UserSettingsResponse,
  WorkoutResponse,
  SupplementAsOfResponse,
  SupplementAiSuggestionResponse,
  SupplementCatalogEntry,
  SupplementLabelLookupResponse,
  SupplementChange,
  SupplementCreatedResponse,
  SupplementDayType,
  SupplementDose,
  SupplementImportBody,
  SupplementItemDetails,
  SupplementSheetResponse,
  SupplementSlot,
  SupplementStackResponse,
  SupplementStatus,
} from '@lifting-logbook/types';
import { IMPORT_SUGGESTION_DEADLINE_MS, MACROCYCLE_ID_HEADER } from '@lifting-logbook/types';

// ---------------------------------------------------------------------------
// @lifting-logbook/api-client
//
// One typed HTTP client for the lifting-logbook REST API, shared by the web
// app's server and browser code (and, later, mobile). The ONLY axis on which
// consumers differ is the auth-header strategy, so that is the one thing a
// consumer supplies — see ApiClientConfig.getAuthHeaders. Everything else
// (endpoints, DTOs, error handling, cache semantics) lives here so there is a
// single source of truth and no call site can build a request the wrong way.
//
// Consolidates apps/web/lib/api.ts (server) and lib/client-api.ts (browser).
// See issue #466 / flag 3 of the 2026-06-08 architecture review (#464).
// ---------------------------------------------------------------------------

/**
 * The body of `POST /supplements/doses/move` (#1410): moves the items' doses in `from` to `to`, or
 * exactly the doses `doses` names. A named dose no longer where the client saw it is a 400.
 */
export interface MoveSupplementDosesBody {
  itemIds: string[];
  from?: SupplementSlot;
  doses?: { itemId: string; index: number; slot: SupplementSlot }[];
  to: SupplementSlot;
  /** Replaces the moved doses' day types when given; `[]` means every day. */
  dayTypes?: string[];
}

/** The body of `PUT /supplements/settings` (#1411): the day types, and/or the caffeine cutoff, both 24-hour `HH:MM`. */
export interface SupplementSettingsBody {
  dayTypes?: SupplementDayType[];
  caffeineCutoff?: string;
}

/** The body of `POST /supplements/items` and `PATCH /supplements/items/:id` (#1409). */
export type SupplementItemBody = Partial<SupplementItemDetails> & {
  status?: SupplementStatus;
  doses?: SupplementDose[];
  /** Create only: the catalog entry to copy blanks and reference content from. */
  catalogKey?: string;
  /** Create only: save the item unverified, as an AI-suggested one is (#1381). Confirm it with `false`. */
  unverified?: boolean;
};

export interface ApiClientConfig {
  /**
   * Absolute API base URL, e.g. `https://api.example.com` or `http://localhost:3004`.
   *
   * Accepts a thunk (`() => string`) as well as a literal string so the base URL can be
   * resolved **per request at runtime** rather than captured once at construction. The
   * browser client uses this to read a runtime-injected value (`window.__PUBLIC_CONFIG__`)
   * that is not known when this module first evaluates — see issue #396 / ADR-028. Server
   * callers continue to pass a literal string.
   */
  baseUrl: string | (() => string);
  /**
   * Resolves the auth headers for a single request. The returned map is merged
   * into every request with **auth-wins precedence** (see {@link createApiClient}),
   * so a call site can never accidentally clobber `Authorization` /
   * `X-Clerk-Authorization`. Server and browser supply different strategies:
   *   - server: Clerk JWT in `X-Clerk-Authorization`, GCP identity token in
   *     `Authorization` (Cloud Run IAM consumes `Authorization`);
   *   - browser: Clerk JWT in plain `Authorization` (no IAM hop).
   * Encapsulating the split here is the structural mitigation for flag 6 (#464).
   */
  getAuthHeaders: () => Promise<Record<string, string>>;
  /**
   * Overrides the default per-request timeout (ms) applied to every request that
   * doesn't already carry its own `signal`. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   * Exists mainly so tests can force a bounded request to time out quickly instead
   * of waiting out the production default — see {@link rawFetch}.
   */
  requestTimeoutMs?: number;
}

// RequestInit augmented with Next.js's ISR `next` extension. The package does not
// depend on `next`, so the DOM `RequestInit` type does not model `next`; we model
// it locally and forward it (the browser ignores the unknown field, Next.js reads
// it on the server). Mirrors the `as RequestInit` cast the pre-consolidation code used.
type FetchInit = RequestInit & { next?: { revalidate?: number; tags?: string[] } };

const enc = encodeURIComponent;
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

// Bounds every request this package makes. Before this, no call site anywhere in
// the package ever passed a `signal`, so a genuinely hung connection (a proxy
// silently dropping the response, a backend that accepts the connection but never
// replies) left the calling `await` pending forever — which, via ImportWizard's
// `disabled={draft?.busy ?? false}` remap-row controls, permanently stranded the
// row with no recovery short of a full wizard reset (#922). 30s is comfortably
// above any real request in this app (Cloud Run's own default request timeout is
// 5 minutes) while still bounding the wait a hung request forces on the caller.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// An import suggestion request waits on an LLM (#1174). Before the model's deadline, the server
// reads the file's grouping (a 30 s transaction, after up to 2 s waiting for a connection) and
// counts the request (5 s, after up to 2 s): 39 s. The rest of the margin is for the upload and
// the reply. Shorter than that, the client could give up on a request the server has counted.
const SUGGEST_TIMEOUT_MS = IMPORT_SUGGESTION_DEADLINE_MS + 60_000;
const DATA_EXPORT_TIMEOUT_MS = 60_000;
// Clear, restore and a snapshot's sets run in a 60 s transaction on the server (#1309), which
// includes waiting up to 5 s for an import's lock. The rest covers getting a connection and the reply.
const TRAINING_DATA_TIMEOUT_MS = 90_000;

/** A sets download's filter as query values, leaving out the ones not set. */
function exportQuery(filter: LiftRecordExportQuery & { part?: number; split?: string }): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

// The import query options every smart-import route takes.
function importQuery(
  params: URLSearchParams,
  destination?: ImportKind,
  opts?: Pick<CommitImportOpts, 'overrides' | 'splitDest'>,
): URLSearchParams {
  if (destination) params.set('destination', destination);
  if (opts?.overrides && Object.keys(opts.overrides).length > 0) {
    params.set('overrides', JSON.stringify(opts.overrides));
  }
  if (opts?.splitDest) {
    params.set('splitDest', '1');
  }
  return params;
}

// Smart-import endpoint path with mode + optional destination override. Returned
// relative (rawFetch prepends baseUrl).
function importPath(
  program: string,
  mode: 'preview' | 'commit' | 'dry-run' | 'assign',
  destination?: ImportKind,
  opts?: Pick<CommitImportOpts, 'overrides' | 'splitDest'>,
): string {
  const params = importQuery(new URLSearchParams({ mode }), destination, opts);
  return `/programs/${enc(program)}/import?${params.toString()}`;
}

// The suggestions route (#1174), which reads the file as the Assign step does but takes no mode.
function suggestionsPath(program: string, opts?: Pick<CommitImportOpts, 'overrides' | 'splitDest'>): string {
  const query = importQuery(new URLSearchParams(), undefined, opts).toString();
  return `/programs/${enc(program)}/import/suggestions${query ? `?${query}` : ''}`;
}

// Import form. The per-row options go in the body, not the URL: with one entry per
// row they outgrow Node's 16 KB header limit at about 300 rows (#1121).
function importForm(file: File, opts?: CommitImportOpts): FormData {
  const form = new FormData();
  if (opts?.excludeKeys && opts.excludeKeys.length > 0) {
    form.append('excludeKeys', JSON.stringify(opts.excludeKeys));
  }
  if (opts?.liftOverrides && Object.keys(opts.liftOverrides).length > 0) {
    form.append('liftOverrides', JSON.stringify(opts.liftOverrides));
  }
  if (opts?.breakdown) form.append('breakdown', JSON.stringify(opts.breakdown));
  if (opts?.today) form.append('today', opts.today);
  form.append('file', file);
  return form;
}

/** The server's answer to a commit or dry run: its response, or validation errors as data. */
export type ImportCommitResult<T> = { ok: true; data: T } | { ok: false; errors: ImportError[] };

/** Phase 3 options for commitImport. */
export interface CommitImportOpts {
  /** Map sourceHeader → destinationField to rename non-standard columns before parsing. */
  overrides?: Record<string, string>;
  /**
   * Rows to exclude from the commit: `__row_<rowIndex>` for a row with a position, which
   * leaves another row sharing its natural key alone (#1123), or the row's natural key.
   */
  excludeKeys?: string[];
  /** Map of 1-based row index → lift id: ambiguous lift-record rows, or strength-goal rows kept apart. */
  liftOverrides?: Record<number, string>;
  /** When true, 1RM lift-record rows are split to Training Maxes. */
  splitDest?: boolean;
  /** The lifter's confirmed Assign breakdown (#1254), for a lift-records dry run or commit. */
  breakdown?: ImportBreakdown;
  /** The lifter's local day, `YYYY-MM-DD`, that suggested statuses are judged against (#1253). */
  today?: string;
}

// Carries the upstream HTTP status alongside the message so a caller that needs
// to distinguish failure classes (e.g. 401/403 auth failures vs. a generic 500)
// can do so without re-parsing the message string. `code` is the API's own error
// code when it sends one, such as `macrocycle-moved` (#1198), and `body` the whole
// error response.
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly body?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

// NestJS ValidationPipe returns { statusCode, message: string | string[], error }.
// Surface that detail so error UIs can show actionable text instead of just
// "Request failed: 400".
async function readError(res: Response, path: string): Promise<ApiClientError> {
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = await res.json();
    if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // fall through to generic
  }
  const raw = body?.message;
  const message = Array.isArray(raw)
    ? raw.join('; ')
    : typeof raw === 'string'
      ? raw
      : `API ${res.status} ${res.statusText} for ${path}`;
  return new ApiClientError(message, res.status, typeof body?.code === 'string' ? body.code : undefined, body);
}

/**
 * The errors a failed import shows. A 409 `macrocycle-busy` (#1198) has no `errors`, but its
 * message asks the importer to try again, so it's shown rather than a bare HTTP status.
 */
function importFailureErrors(status: number, body: { errors?: ImportError[]; code?: unknown; message?: unknown }): ImportError[] {
  if (body.errors) return body.errors;
  const shown = body.code === 'macrocycle-busy' || body.code === 'overwrite-backup-failed';
  const message = shown && typeof body.message === 'string' ? body.message : `Unexpected error (HTTP ${status})`;
  return [{ row: 0, code: 'UNEXPECTED_ERROR', message }];
}

async function extractErrorMessage(res: Response, path: string): Promise<string> {
  return (await readError(res, path)).message;
}

/** JSON headers plus the page's macrocycle id, when it has one. */
function macrocycleHeaders(macrocycleId: string | undefined, json = true): Record<string, string> {
  return {
    ...(json ? JSON_HEADERS : {}),
    ...(macrocycleId ? { [MACROCYCLE_ID_HEADER]: macrocycleId } : {}),
  };
}

export function createApiClient(config: ApiClientConfig) {
  const { baseUrl, getAuthHeaders, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = config;
  // Resolve per request so a thunk baseUrl picks up a runtime-injected value
  // (e.g. window.__PUBLIC_CONFIG__) that was not available at construction (#396).
  const resolveBaseUrl = (): string => (typeof baseUrl === 'function' ? baseUrl() : baseUrl);

  async function rawFetch(path: string, init: FetchInit = {}): Promise<Response> {
    const authHeaders = await getAuthHeaders();
    const finalInit: FetchInit = {
      ...init,
      // auth-wins: spread auth headers last so a call site's init.headers can
      // never override Authorization / X-Clerk-Authorization.
      headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders },
      // Bound every request that doesn't already carry its own signal (#922). A call
      // site's own signal takes precedence rather than being silently clobbered: the
      // downloads, clear and restore pass a longer timeout of their own.
      signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
    };
    return fetch(`${resolveBaseUrl()}${path}`, finalInit as RequestInit);
  }

  // Throws a rich error on !ok; returns undefined on 204; otherwise parses JSON.
  async function request<T>(path: string, init?: FetchInit): Promise<T> {
    const res = await rawFetch(path, init);
    if (!res.ok) throw await readError(res, path);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // Like request but returns null on 404 (and 204) instead of throwing.
  async function requestNullable<T>(path: string, init?: FetchInit): Promise<T | null> {
    const res = await rawFetch(path, init);
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw await readError(res, path);
    return (await res.json()) as T;
  }

  // Like request but returns null on 409 Conflict instead of throwing.
  // Use for POST operations that are idempotent by intent — where a conflict
  // means the resource already exists in the desired state and the caller
  // doesn't need to know why (only initializeMacrocycle uses this — a single
  // conflict cause, "a macrocycle already exists").
  async function requestOrConflict<T>(path: string, init?: FetchInit): Promise<T | null> {
    const res = await rawFetch(path, init);
    if (res.status === 409) {
      // An import holding the macrocycle lock (#1198) doesn't mean the resource exists.
      const err = await readError(res, path);
      if (err.code === 'import-in-progress') throw err;
      return null;
    }
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw await readError(res, path);
    return (await res.json()) as T;
  }

  // Like requestOrConflict, but surfaces the 409 body's message instead of
  // discarding it. Use when an endpoint can 409 for more than one reason and
  // a caller must tell them apart — e.g. custom-lift creation 409s both for
  // a duplicate name (CustomLiftConflictError) and for a name that shadows a
  // built-in canonical alias (ReservedLiftNameConflictError); collapsing
  // both to bare `null` left a caller unable to state the true cause and
  // reusing one error's wording for the other's conflict was simply false
  // (#917). initializeMacrocycle deliberately keeps using requestOrConflict
  // above, unaffected by this addition.
  async function requestOrConflictWithReason<T>(
    path: string,
    init?: FetchInit,
  ): Promise<{ ok: true; data: T } | { ok: false; conflictMessage: string }> {
    const res = await rawFetch(path, init);
    if (res.status === 409) {
      return { ok: false, conflictMessage: await extractErrorMessage(res, path) };
    }
    if (res.status === 204) return { ok: true, data: undefined as T };
    if (!res.ok) throw await readError(res, path);
    return { ok: true, data: (await res.json()) as T };
  }

  // A file the browser saves: throws the API's error on !ok, otherwise returns the body.
  async function requestBlob(path: string, timeoutMs: number): Promise<Blob> {
    const res = await rawFetch(path, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw await readError(res, path);
    return res.blob();
  }

  // Void request that treats 404 as success — for idempotent deletes, where an
  // already-absent resource is the desired end state.
  async function requestVoidIdempotent(path: string, init?: FetchInit): Promise<void> {
    const res = await rawFetch(path, init);
    if (!res.ok && res.status !== 404) {
      throw await readError(res, path);
    }
  }

  return {
    // -- Macrocycles ----------------------------------------------------------
    fetchMacrocycleDashboard(program: string): Promise<MacrocycleDashboardResponse | null> {
      return requestNullable(`/programs/${enc(program)}/macrocycles/current`, { cache: 'no-store' });
    },
    createMacrocycle(programId: string): Promise<MacrocycleDashboardResponse> {
      return request(`/programs/${enc(programId)}/macrocycles`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
        cache: 'no-store',
      });
    },
    // Returns null when a macrocycle already exists (409) — the caller should treat
    // null as "already initialized" and redirect rather than error.
    initializeMacrocycle(
      programId: string,
      options: { macrocycleDate?: string } = {},
    ): Promise<MacrocycleDashboardResponse | null> {
      return requestOrConflict(`/programs/${enc(programId)}/macrocycles/initialize`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(options),
        cache: 'no-store',
      });
    },
    /** Every macrocycle of the program, past and current, in start-date order (ADR-042). */
    fetchMacrocycles(program: string): Promise<MacrocycleSummaryResponse[]> {
      return request(`/programs/${enc(program)}/macrocycles`, { cache: 'no-store' });
    },
    /** The imports that touched the program's past macrocycles, newest first, each undoable (#1257). */
    fetchImportBatches(program: string): Promise<ImportBatchSummary[]> {
      return request(`/programs/${enc(program)}/import/batches`, { cache: 'no-store' });
    },
    /** The program's training-maxes imports, newest first, each undoable (#1405). */
    fetchTrainingMaxImportBatches(program: string): Promise<TrainingMaxImportBatchSummary[]> {
      return request(`/programs/${enc(program)}/import/batches?destination=training-maxes`, { cache: 'no-store' });
    },
    /** What overwriting all or all imported history would remove, for Assign (#1182). */
    fetchOverwriteCounts(program: string): Promise<ImportOverwriteCountsResponse> {
      return request(`/programs/${enc(program)}/import/overwrite-counts`, { cache: 'no-store' });
    },
    /** What overwriting the date range `from`–`to` would remove, for Assign (#1182). */
    async fetchOverwriteRangeCounts(program: string, from: string, to: string): Promise<ImportOverwriteCounts> {
      const query = new URLSearchParams({ from, to });
      const res = await request<ImportOverwriteRangeCountsResponse>(
        `/programs/${enc(program)}/import/overwrite-counts?${query.toString()}`,
        { cache: 'no-store' },
      );
      return res.range;
    },
    // Idempotent delete: a 404 (no existing macrocycle) is treated as success, matching
    // deleteStrengthGoal/deleteCustomProgram below.
    deleteCurrentMacrocycle(programId: string): Promise<void> {
      return requestVoidIdempotent(`/programs/${enc(programId)}/macrocycles/current`, {
        method: 'DELETE',
        cache: 'no-store',
      });
    },

    // Re-dates the current macrocycle by the saved schedule, from `today` (YYYY-MM-DD, the
    // lifter's local date), or takes it out of schedule mode when none is saved (#1032).
    redateCurrentMacrocycle(programId: string, today: string): Promise<RedateMacrocycleResponse> {
      return request(`/programs/${enc(programId)}/macrocycles/current/redate`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ today }),
        cache: 'no-store',
      });
    },

    // -- Program spec ------------------------------------------------------
    fetchProgramSpec(program: string): Promise<LiftingProgramSpecResponse[]> {
      return request(`/programs/${enc(program)}/spec`, { next: { revalidate: 3600 } });
    },

    // -- Training maxes ----------------------------------------------------
    fetchTrainingMaxes(program: string): Promise<TrainingMaxResponse[]> {
      return request(`/programs/${enc(program)}/training-maxes`, { cache: 'no-store' });
    },
    fetchTrainingMaxHistory(program: string): Promise<TrainingMaxHistoryResponse> {
      return request(`/programs/${enc(program)}/training-maxes/history`, { cache: 'no-store' });
    },
    updateTrainingMaxHistoryEntry(
      program: string,
      id: string,
      body: { isPR?: boolean; goalMet?: boolean },
    ): Promise<TrainingMaxHistoryResponse['entries'][number]> {
      return request(
        `/programs/${enc(program)}/training-maxes/history/${enc(id)}`,
        { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body), cache: 'no-store' },
      );
    },
    updateTrainingMaxes(
      program: string,
      body: UpdateTrainingMaxesRequest,
    ): Promise<TrainingMaxResponse[]> {
      return request(`/programs/${enc(program)}/training-maxes`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    /**
     * Lifts with logged sets and no training max, each with an estimate (#1246). `lifts` narrows
     * the list to those lifts, by any spelling; an empty `lifts` asks about none, so it sends no
     * request (the server reads a missing `lifts` as every lift).
     */
    async fetchMissingTrainingMaxes(
      program: string,
      lifts?: readonly string[],
    ): Promise<MissingTrainingMaxResponse[]> {
      if (lifts?.length === 0) return [];
      const query = lifts ? `?${lifts.map((lift) => `lifts=${enc(lift)}`).join('&')}` : '';
      return request(`/programs/${enc(program)}/training-maxes/missing${query}`, { cache: 'no-store' });
    },
    /** "Don't ask again" for a lift, by the `liftId` the missing list reports. Idempotent. */
    dismissMissingTrainingMax(program: string, liftId: string): Promise<void> {
      return request(`/programs/${enc(program)}/training-maxes/missing/${enc(liftId)}/dismissal`, {
        method: 'PUT',
        cache: 'no-store',
      });
    },
    /** "Ask again": clears a lift's dismissal. Idempotent. */
    undismissMissingTrainingMax(program: string, liftId: string): Promise<void> {
      return request(`/programs/${enc(program)}/training-maxes/missing/${enc(liftId)}/dismissal`, {
        method: 'DELETE',
        cache: 'no-store',
      });
    },

    // -- Workouts ----------------------------------------------------------
    fetchWorkout(program: string, workoutNum: number): Promise<WorkoutResponse | null> {
      return requestNullable(`/programs/${enc(program)}/workouts/${workoutNum}`, {
        cache: 'no-store',
      });
    },
    rescheduleWorkout(
      program: string,
      macrocycleNum: number,
      workoutNum: number,
      newDate: string,
      macrocycleId?: string,
    ): Promise<void> {
      // Typed against the shared contract so a change to RescheduleRequest surfaces
      // here at compile time rather than as a silently malformed request body.
      const body: RescheduleRequest = { newDate };
      return request(
        `/programs/${enc(program)}/macrocycles/${macrocycleNum}/workouts/${workoutNum}/reschedule`,
        { method: 'PATCH', headers: macrocycleHeaders(macrocycleId), body: JSON.stringify(body), cache: 'no-store' },
      );
    },
    skipWorkout(
      program: string,
      macrocycleNum: number,
      workoutNum: number,
      reason?: string,
      macrocycleId?: string,
    ): Promise<void> {
      return request(
        `/programs/${enc(program)}/macrocycles/${macrocycleNum}/workouts/${workoutNum}/skip`,
        {
          method: 'POST',
          headers: macrocycleHeaders(macrocycleId),
          body: JSON.stringify(reason !== undefined ? { reason } : {}),
          cache: 'no-store',
        },
      );
    },
    unskipWorkout(program: string, macrocycleNum: number, workoutNum: number, macrocycleId?: string): Promise<void> {
      return request(
        `/programs/${enc(program)}/macrocycles/${macrocycleNum}/workouts/${workoutNum}/skip`,
        { method: 'DELETE', headers: macrocycleHeaders(macrocycleId, false), cache: 'no-store' },
      );
    },

    // -- Lift records ------------------------------------------------------
    fetchLiftRecords(program: string): Promise<LiftRecordResponse[]> {
      return request(`/programs/${enc(program)}/lift-records`, { cache: 'no-store' });
    },
    createLiftRecord(program: string, body: CreateLiftRecordRequest, macrocycleId?: string): Promise<LiftRecordResponse> {
      return request(`/programs/${enc(program)}/lift-records`, {
        method: 'POST',
        headers: macrocycleHeaders(macrocycleId),
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    updateLiftRecord(
      program: string,
      id: string,
      body: UpdateLiftRecordRequest,
      macrocycleId?: string,
    ): Promise<LiftRecordResponse> {
      return request(`/programs/${enc(program)}/lift-records/${enc(id)}`, {
        method: 'PATCH',
        headers: macrocycleHeaders(macrocycleId),
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    // -- Non-cycle workouts (proposal 2026-11-06, decision 23, #1184) --------
    // Later sets and edits go through createLiftRecord/updateLiftRecord under NON_CYCLE_PROGRAM,
    // with the workout's macrocycleId.
    /** Every non-cycle set, newest workout first, whichever program is active. */
    fetchNonCycleRecords(): Promise<LiftRecordResponse[]> {
      return request('/non-cycle-workouts', { cache: 'no-store' });
    },
    fetchNonCycleWorkout(workoutNum: number): Promise<NonCycleWorkoutResponse | null> {
      return requestNullable(`/non-cycle-workouts/${workoutNum}`, { cache: 'no-store' });
    },
    /** Starts a non-cycle workout with its first set. */
    createNonCycleWorkout(body: CreateNonCycleWorkoutRequest): Promise<NonCycleWorkoutResponse> {
      return request('/non-cycle-workouts', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    deleteNonCycleWorkout(workoutNum: number, macrocycleId: string): Promise<void> {
      return request(`/non-cycle-workouts/${workoutNum}`, {
        method: 'DELETE',
        headers: macrocycleHeaders(macrocycleId, false),
        cache: 'no-store',
      });
    },
    /** The active program's training max for a lift, and the reps last done at the previous one. */
    fetchNonCycleReference(program: string, lift: string): Promise<NonCycleReferenceResponse> {
      return request(`/programs/${enc(program)}/non-cycle-reference?lift=${enc(lift)}`, { cache: 'no-store' });
    },

    /**
     * Uploads a CSV file to the lift-records import endpoint. Returns a
     * discriminated union so callers can handle validation errors without
     * catching exceptions. FormData sets its own multipart Content-Type
     * boundary, so no Content-Type header is supplied here.
     */
    async importLiftRecords(
      program: string,
      file: File,
    ): Promise<
      { ok: true; data: ImportLiftRecordsResponse } | { ok: false; errors: ImportError[] }
    > {
      const form = new FormData();
      form.append('file', file);
      const res = await rawFetch(`/programs/${enc(program)}/lift-records/import`, {
        method: 'POST',
        body: form,
        cache: 'no-store',
      });
      if (res.status === 201) {
        return { ok: true, data: (await res.json()) as ImportLiftRecordsResponse };
      }
      const body = (await res.json()) as { errors?: ImportError[]; code?: unknown; message?: unknown };
      return { ok: false, errors: importFailureErrors(res.status, body) };
    },

    // -- Smart import (classify → preview → commit any CSV) ----------------
    /**
     * Smart Import — classify + preview a CSV without writing (#477). Pass a
     * `destination` to override the classifier (e.g. after a low-confidence pick).
     * `liftOverrides` applies only to a strength-goal preview (#1169).
     */
    async previewImport(
      program: string,
      file: File,
      destination?: ImportKind,
      opts?: Pick<CommitImportOpts, 'overrides' | 'liftOverrides'>,
    ): Promise<ImportPreviewResponse> {
      const res = await rawFetch(importPath(program, 'preview', destination, opts), {
        method: 'POST',
        body: importForm(file, opts),
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`Import preview failed (HTTP ${res.status})`);
      }
      return (await res.json()) as ImportPreviewResponse;
    },
    /**
     * Smart Import — commit a CSV to the chosen destination. The server re-parses the
     * file (never trusting any client payload) and writes idempotently. Returns a
     * discriminated union so callers handle row validation errors without catching; any
     * other refusal, a coded 400 such as `breakdown-mismatch` included, throws an
     * `ApiClientError`, as `dryRunImport` does (#1256).
     * Phase 3: pass `opts` for column overrides, row exclusions, lift remapping, or
     * 1RM split routing.
     */
    async commitImport(
      program: string,
      file: File,
      destination: ImportKind,
      opts?: CommitImportOpts,
    ): Promise<ImportCommitResult<ImportCommitResponse>> {
      const path = importPath(program, 'commit', destination, opts);
      const res = await rawFetch(path, {
        method: 'POST',
        body: importForm(file, opts),
        cache: 'no-store',
      });
      if (res.ok) {
        return { ok: true, data: (await res.json()) as ImportCommitResponse };
      }
      const body = (await res.clone().json().catch(() => ({}))) as { errors?: ImportError[]; code?: unknown; message?: unknown };
      // A request the server refused with a code, such as a breakdown that no longer matches the
      // file (#1256), or overwrite counts the stored history no longer matches (#1182), isn't a
      // problem with the file: it's thrown with its code, as `dryRunImport` throws it.
      const refused = res.status === 400 || body.code === 'overwrite-counts-changed';
      if (refused && !body.errors && typeof body.code === 'string') throw await readError(res, path);
      return { ok: false, errors: importFailureErrors(res.status, body) };
    },
    /**
     * Smart Import — the rules' grouping of a lift-records file into suggested macrocycles, for
     * the Assign step (#1253). Nothing is written. Throws on any failure, with the API's code.
     */
    async assignImport(
      program: string,
      file: File,
      opts?: Pick<CommitImportOpts, 'overrides' | 'excludeKeys' | 'liftOverrides' | 'splitDest' | 'today'>,
    ): Promise<ImportAssignResponse> {
      const path = importPath(program, 'assign', 'lift-records', opts);
      const res = await rawFetch(path, { method: 'POST', body: importForm(file, opts), cache: 'no-store' });
      if (!res.ok) throw await readError(res, path);
      return (await res.json()) as ImportAssignResponse;
    },
    /**
     * Smart Import — an LLM's suggestions for the Assign step's grouping (#1174), sent only once
     * the lifter has said yes. `notes` sends the file's workout notes too. `signal` lets the wizard
     * abort the request when the lifter leaves the step. Throws on any failure, with the API's code.
     */
    async suggestImport(
      program: string,
      file: File,
      opts: Pick<CommitImportOpts, 'overrides' | 'excludeKeys' | 'liftOverrides' | 'splitDest' | 'today'> & {
        notes: boolean;
      },
      signal?: AbortSignal,
    ): Promise<ImportSuggestionsResponse> {
      const path = suggestionsPath(program, opts);
      const form = importForm(file, opts);
      if (opts.notes) form.set('notes', '1');
      // The caller's signal and this request's own timeout, combined by hand: `AbortSignal.any`
      // is missing from Safari before 17.4.
      const bounded = new AbortController();
      const timer = setTimeout(() => bounded.abort(new DOMException('Timed out', 'TimeoutError')), SUGGEST_TIMEOUT_MS);
      const onAbort = () => bounded.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await rawFetch(path, { method: 'POST', body: form, cache: 'no-store', signal: bounded.signal });
        if (!res.ok) throw await readError(res, path);
        return (await res.json()) as ImportSuggestionsResponse;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
    /**
     * Smart Import — reports the counts `commitImport` would return for these same
     * arguments, and the same validation errors, without writing anything (#1123).
     * Throws on any other failure, so an outage isn't reported as a problem with the file.
     */
    async dryRunImport(
      program: string,
      file: File,
      destination: ImportKind,
      opts?: CommitImportOpts,
    ): Promise<ImportCommitResult<ImportDryRunResponse>> {
      const path = importPath(program, 'dry-run', destination, opts);
      const res = await rawFetch(path, {
        method: 'POST',
        body: importForm(file, opts),
        cache: 'no-store',
      });
      if (res.ok) {
        return { ok: true, data: (await res.json()) as ImportDryRunResponse };
      }
      const body = (await res.clone().json().catch(() => ({}))) as { errors?: ImportError[] };
      if (body.errors) return { ok: false, errors: body.errors };
      throw await readError(res, path);
    },

    /**
     * Phase 3: Undo a committed import by its batch ID. Restores prior values for
     * updated records, deletes newly created rows, and skips rows edited since import.
     * `today` is the user's calendar day (YYYY-MM-DD), which the statuses of the macrocycles
     * it reads again are judged against (#1255).
     */
    async undoImport(program: string, batchId: string, today: string): Promise<ImportUndoResponse> {
      const path = `/programs/${enc(program)}/import/${enc(batchId)}/undo?today=${enc(today)}`;
      const res = await rawFetch(path, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        // A 409 macrocycle-busy (#1198) or import-in-progress (an overwrite's undo waits for no
        // other import) carries a message asking to try again, an overwrite's refusal (#1182) says
        // why it can't be undone or what to undo first, and a 400 says what to fix, such as a
        // device clock too far from the server's (#1257). Anything else keeps the generic message
        // the import wizard shows, with the status, code and body.
        const err = await readError(res, path);
        if (err.code === 'macrocycle-busy' || err.code === 'import-in-progress' || err.code?.startsWith('overwrite-undo-')) throw err;
        if (res.status === 400 && typeof err.body?.message === 'string') throw err;
        throw new ApiClientError(`Undo import failed (HTTP ${res.status})`, err.status, err.code, err.body);
      }
      return (await res.json()) as ImportUndoResponse;
    },

    /**
     * Fetch a link-shared Google Sheets workbook and classify each tab (#1111).
     * Importable tabs come back as CSV text for the regular previewImport /
     * commitImport flow. Throws with the server's message (e.g. how to share a
     * private sheet) on failure.
     */
    fetchGoogleSheetWorkbook(program: string, url: string): Promise<GoogleSheetWorkbookResponse> {
      const body: GoogleSheetImportRequest = { url };
      return request(`/programs/${enc(program)}/import/google-sheet`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    // -- Link a Google Sheet (#1433, ADR-047) --------------------------------
    /** The lifter's link; `configured: false` when this API has no Google client. */
    fetchGoogleSheetLink(): Promise<GoogleSheetLinkView> {
      return request('/integrations/google-sheet', { cache: 'no-store' });
    },
    /** Google's consent URL for the browser to go to. 503 `google-sheet-unconfigured` when not set up. */
    authorizeGoogleSheet(): Promise<{ url: string }> {
      return request('/integrations/google-sheet/authorize', { method: 'POST', cache: 'no-store' });
    },
    /** Completes the link from the `code` and `state` Google redirected back with. */
    completeGoogleSheetLink(code: string, state: string): Promise<GoogleSheetLinkView> {
      return request('/integrations/google-sheet/callback', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ code, state }),
        cache: 'no-store',
      });
    },
    /** Makes a new spreadsheet when the linked one is gone. */
    createGoogleSheetSpreadsheet(): Promise<GoogleSheetLinkView> {
      return request('/integrations/google-sheet/sheet', { method: 'POST', cache: 'no-store' });
    },
    /**
     * Sync now: enqueues a mirror run. 409 `google-sheet-not-linked` when nothing is linked,
     * `google-sheet-needs-relink` when Google access was removed, `google-sheet-missing` when the
     * sheet is gone; 502 `sheet-mirror-enqueue-failed`.
     */
    syncGoogleSheet(): Promise<{ queued: true }> {
      return request('/integrations/google-sheet/sync', { method: 'POST', cache: 'no-store' });
    },
    /** Deletes the link, revoking Google's grant if it can. */
    unlinkGoogleSheet(): Promise<GoogleSheetUnlinkResult> {
      return request('/integrations/google-sheet', { method: 'DELETE', cache: 'no-store' });
    },

    // -- Supplements (#1376) ------------------------------------------------
    /** The lifter's stack, day types and caffeine cutoff. */
    fetchSupplements(): Promise<SupplementStackResponse> {
      return request('/supplements', { cache: 'no-store' });
    },
    /** Reads a link-shared Google Sheet for the supplement import: each tab's rows and hyperlinks (#1379). */
    fetchSupplementSheet(url: string): Promise<SupplementSheetResponse> {
      return request('/supplements/import/google-sheet', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ url }),
        cache: 'no-store',
      });
    },
    /** Saves the reviewed rows as items in one write, each logged as "Imported from <source>" (#1379). */
    importSupplements(body: SupplementImportBody, today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/import?today=${enc(today)}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    /** Catalog entries whose name or alias contains `q`, for autofill (#1409). */
    fetchSupplementCatalog(q: string): Promise<SupplementCatalogEntry[]> {
      return request(`/supplements/catalog?q=${enc(q)}`, { cache: 'no-store' });
    },
    /**
     * Tier 2 (#1381): product labels for a name the catalog doesn't have. Never rejects for a
     * label-database outage; that is `unavailable`. A POST, so the name stays out of URLs and logs.
     */
    fetchSupplementLabelLookup(q: string): Promise<SupplementLabelLookupResponse> {
      return request(`/supplements/label-lookup`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: q }),
        cache: 'no-store',
      });
    },
    /** Tier 3 (#1381): an AI suggestion from the typed name alone. Counts against the lifter's hourly allowance. */
    fetchSupplementAiSuggestion(name: string): Promise<SupplementAiSuggestionResponse> {
      return request(`/supplements/ai-suggestion`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
        cache: 'no-store',
      });
    },
    /** Adds an item. With `catalogKey`, the API fills blanks from that entry and attaches its reference content. */
    createSupplementItem(body: SupplementItemBody, today: string): Promise<SupplementCreatedResponse> {
      return request(`/supplements/items?today=${enc(today)}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    /** Removes an item; the API keeps it in the change log so it can be restored. */
    removeSupplementItem(id: string, today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/items/${enc(id)}?today=${enc(today)}`, { method: 'DELETE', cache: 'no-store' });
    },
    /** Removes the listed items in one write: all of them, or none if any is unknown (#1414). */
    removeSupplementItems(itemIds: string[], today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/items/remove?today=${enc(today)}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ itemIds }),
        cache: 'no-store',
      });
    },
    /** Edits an item, such as the links Keep saves. `today` is the lifter's local date (YYYY-MM-DD). */
    updateSupplementItem(id: string, body: SupplementItemBody, today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/items/${enc(id)}?today=${enc(today)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    /** Moves the listed items' doses from one slot to another (#1410). */
    moveSupplementDoses(body: MoveSupplementDosesBody, today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/doses/move?today=${enc(today)}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    /** Marks the listed items active or pending (#1410). */
    setSupplementStatus(itemIds: string[], status: SupplementStatus, today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/items/status?today=${enc(today)}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ itemIds, status }),
        cache: 'no-store',
      });
    },
    /** Combines two or more items into a new mix (#1410). */
    createSupplementMix(name: string, itemIds: string[], today: string): Promise<SupplementCreatedResponse> {
      return request(`/supplements/mixes?today=${enc(today)}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name, itemIds }),
        cache: 'no-store',
      });
    },

    /** Replaces the day types and/or sets the caffeine cutoff (#1411). A 400 names a workout dose left with no day type. */
    updateSupplementSettings(body: SupplementSettingsBody, today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/settings?today=${enc(today)}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    // -- Supplement history (#1378) -----------------------------------------
    /** A page of the change log, oldest first. The next page back is `beforeSeq` = the first change's `seq`. */
    fetchSupplementChanges(opts: { beforeSeq?: number; limit?: number } = {}): Promise<SupplementChange[]> {
      const q = new URLSearchParams();
      if (opts.beforeSeq !== undefined) q.set('beforeSeq', String(opts.beforeSeq));
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return request(`/supplements/changes${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
    },
    /** The stack and day types at the end of `date` (`YYYY-MM-DD`), replayed from the change log. */
    fetchSupplementsAsOf(date: string): Promise<SupplementAsOfResponse> {
      return request(`/supplements/as-of/${enc(date)}`, { cache: 'no-store' });
    },
    /** Brings a removed item back with its doses and status. `today` is the lifter's local date. */
    restoreSupplementItem(id: string, today: string): Promise<SupplementStackResponse> {
      return request(`/supplements/items/${enc(id)}/restore?today=${enc(today)}`, { method: 'POST', cache: 'no-store' });
    },

    // -- Body weight -------------------------------------------------------
    recordBodyWeight(program: string, body: RecordBodyWeightRequest): Promise<void> {
      return request(`/programs/${enc(program)}/body-weight`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    fetchLatestBodyWeight(program: string): Promise<BodyWeightResponse | null> {
      return requestNullable(`/programs/${enc(program)}/body-weight/latest`, { cache: 'no-store' });
    },

    // -- Strength goals ----------------------------------------------------
    fetchStrengthGoals(program: string): Promise<StrengthGoalResponse[]> {
      return request(`/programs/${enc(program)}/strength-goals`, { cache: 'no-store' });
    },
    upsertStrengthGoal(
      program: string,
      lift: string,
      body: UpsertStrengthGoalRequest,
    ): Promise<StrengthGoalResponse> {
      return request(`/programs/${enc(program)}/strength-goals/${enc(lift)}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    deleteStrengthGoal(program: string, lift: string): Promise<void> {
      return requestVoidIdempotent(`/programs/${enc(program)}/strength-goals/${enc(lift)}`, {
        method: 'DELETE',
        cache: 'no-store',
      });
    },

    // -- Lift overrides ----------------------------------------------------
    upsertLiftOverride(
      program: string,
      macrocycleNum: number,
      workoutNum: number,
      body: CreateLiftOverrideRequest,
      macrocycleId?: string,
    ): Promise<LiftOverrideResponse> {
      return request(
        `/programs/${enc(program)}/macrocycles/${macrocycleNum}/workouts/${workoutNum}/lift-overrides`,
        { method: 'POST', headers: macrocycleHeaders(macrocycleId), body: JSON.stringify(body), cache: 'no-store' },
      );
    },
    deleteLiftOverride(
      program: string,
      macrocycleNum: number,
      workoutNum: number,
      lift: string,
      macrocycleId?: string,
    ): Promise<void> {
      return request(
        `/programs/${enc(program)}/macrocycles/${macrocycleNum}/workouts/${workoutNum}/lift-overrides/${enc(lift)}`,
        { method: 'DELETE', headers: macrocycleHeaders(macrocycleId, false), cache: 'no-store' },
      );
    },

    // -- Lifts / metadata --------------------------------------------------
    fetchLiftCatalog(program: string): Promise<string[]> {
      return request(`/programs/${enc(program)}/lifts`, { cache: 'no-store' });
    },
    fetchLiftMetadata(lift: string): Promise<LiftMetadataResponse> {
      return request(`/lifts/${enc(lift)}/metadata`, { cache: 'no-store' });
    },
    /** Every lift the caller has stored metadata for (#1211). */
    fetchAllLiftMetadata(): Promise<LiftMetadataResponse[]> {
      return request('/lifts/metadata', { cache: 'no-store' });
    },
    patchLiftMetadata(lift: string, body: PatchLiftMetadataRequest): Promise<LiftMetadataResponse> {
      return request(`/lifts/${enc(lift)}/metadata`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    fetchCustomLifts(): Promise<CustomLiftResponse[]> {
      return request('/lifts/custom', { cache: 'no-store' });
    },
    // Returns a discriminated result rather than bare null on 409 (#917) —
    // the server's message already distinguishes "a custom lift by this name
    // exists" from "this name is reserved and can never become a custom
    // lift", and the caller needs that distinction to render something true.
    createCustomLift(
      body: CreateCustomLiftRequest,
    ): Promise<{ ok: true; data: CustomLiftResponse } | { ok: false; conflictMessage: string }> {
      return requestOrConflictWithReason('/lifts/custom', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    // -- Lift modifications (#1151) ----------------------------------------
    // `lift` may be any name the lift resolves by; archived modifications are left out.
    fetchLiftModifications(lift: string): Promise<LiftModificationResponse[]> {
      return request(`/lifts/modifications?lift=${enc(lift)}`, { cache: 'no-store' });
    },
    // Several lifts in one request, keyed by the name each was asked under (#1242).
    fetchLiftModificationsByLift(lifts: readonly string[]): Promise<LiftModificationsByLiftResponse> {
      const query = lifts.map((lift) => `lift=${enc(lift)}`).join('&');
      return request(`/lifts/modifications/by-lift?${query}`, { cache: 'no-store' });
    },
    // A 409 means this lift already has a modification of that name.
    createLiftModification(
      body: CreateLiftModificationRequest,
    ): Promise<{ ok: true; data: LiftModificationResponse } | { ok: false; conflictMessage: string }> {
      return requestOrConflictWithReason('/lifts/modifications', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    // A 409 means the new name is taken on this lift (#1153).
    updateLiftModification(
      id: string,
      body: UpdateLiftModificationRequest,
    ): Promise<{ ok: true; data: LiftModificationResponse } | { ok: false; conflictMessage: string }> {
      return requestOrConflictWithReason(`/lifts/modifications/${enc(id)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    // A modification's own max is per program, like a lift's (#1153).
    fetchModificationMaxes(program: string): Promise<ModificationMaxResponse[]> {
      return request(`/programs/${enc(program)}/modification-maxes`, { cache: 'no-store' });
    },
    putModificationMax(
      program: string,
      modificationId: string,
      body: PutModificationMaxRequest,
    ): Promise<ModificationMaxResponse> {
      return request(`/programs/${enc(program)}/modification-maxes/${enc(modificationId)}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    // -- Focus work (#1056) ------------------------------------------------
    // `today` is the user's calendar day (YYYY-MM-DD): block status and the day's focus
    // plan depend on it, and only the client knows the user's time zone.
    fetchFocusBlocks(today: string): Promise<FocusBlockResponse[]> {
      return request(`/focus/blocks?today=${enc(today)}`, { cache: 'no-store' });
    },
    createFocusBlock(body: CreateFocusBlockRequest, today: string): Promise<FocusBlockResponse> {
      return request(`/focus/blocks?today=${enc(today)}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    updateFocusBlock(id: string, body: UpdateFocusBlockRequest, today: string): Promise<FocusBlockResponse> {
      return request(`/focus/blocks/${enc(id)}?today=${enc(today)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    // Idempotent delete: an already-deleted focus block is the desired end state.
    deleteFocusBlock(id: string): Promise<void> {
      return requestVoidIdempotent(`/focus/blocks/${enc(id)}`, { method: 'DELETE', cache: 'no-store' });
    },
    // `ids`: every focus block that has not ended on `today`, highest priority first.
    reorderFocusBlocks(ids: string[], today: string): Promise<FocusBlockResponse[]> {
      const body: ReorderFocusBlocksRequest = { ids };
      return request(`/focus/blocks/order?today=${enc(today)}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    fetchFocusBlockSummary(id: string): Promise<FocusBlockSummaryResponse> {
      return request(`/focus/blocks/${enc(id)}/summary`, { cache: 'no-store' });
    },
    fetchFocusSettings(): Promise<FocusSettingsResponse> {
      return request('/focus/settings', { cache: 'no-store' });
    },
    updateFocusSettings(body: UpdateFocusSettingsRequest): Promise<FocusSettingsResponse> {
      return request('/focus/settings', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    fetchFocusPlan(program: string, workoutNum: number, today: string): Promise<FocusDayPlanResponse> {
      return request(`/programs/${enc(program)}/workouts/${workoutNum}/focus?today=${enc(today)}`, {
        cache: 'no-store',
      });
    },
    fetchFocusDayState(program: string, workoutNum: number): Promise<FocusDayState> {
      return request(`/programs/${enc(program)}/workouts/${workoutNum}/focus-state`, { cache: 'no-store' });
    },
    saveFocusDayState(
      program: string,
      workoutNum: number,
      body: FocusDayState,
      macrocycleId?: string,
    ): Promise<FocusDayState> {
      return request(`/programs/${enc(program)}/workouts/${workoutNum}/focus-state`, {
        method: 'PUT',
        headers: macrocycleHeaders(macrocycleId),
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    // -- User settings -----------------------------------------------------
    /**
     * Download My Data (#947): the whole logbook as one zip. The server allows its reads 30s and
     * then builds the archive outside that, so this outlasts the default bound.
     */
    downloadDataExport(): Promise<Blob> {
      return requestBlob('/users/me/export', DATA_EXPORT_TIMEOUT_MS);
    },
    /** How the sets a filter takes split into parts, for one download per part (#1308). */
    fetchLiftRecordExportParts(filter: LiftRecordExportQuery): Promise<LiftRecordExportPartsResponse> {
      return request(`/users/me/export/lift-records/parts${exportQuery(filter)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(DATA_EXPORT_TIMEOUT_MS),
      });
    },
    /** One part of a filtered sets download as CSV. A `split` that has changed since is a 409. */
    downloadLiftRecordExport(filter: LiftRecordExportQuery & { part: number; split: string }): Promise<Blob> {
      return requestBlob(`/users/me/export/lift-records${exportQuery(filter)}`, DATA_EXPORT_TIMEOUT_MS);
    },
    /** What Clear data would remove (#1309). */
    fetchTrainingDataCounts(): Promise<TrainingDataCounts> {
      return request('/users/me/training-data/counts', { cache: 'no-store' });
    },
    /**
     * Saves a snapshot, then clears the training data. `counts` are the ones the lifter
     * confirmed: if any has changed, nothing is cleared and the 409 (`counts-changed`) carries
     * the current ones in its body.
     */
    clearTrainingData(counts: TrainingDataCounts): Promise<ClearTrainingDataResponse> {
      return request('/users/me/training-data/clear', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ counts }),
        cache: 'no-store',
        signal: AbortSignal.timeout(TRAINING_DATA_TIMEOUT_MS),
      });
    },
    /** The snapshots that haven't expired, newest first. */
    fetchSnapshots(): Promise<DataSnapshotSummary[]> {
      return request('/users/me/snapshots', { cache: 'no-store' });
    },
    /** Puts a snapshot's rows back without overwriting newer ones, then deletes it. */
    restoreSnapshot(id: string): Promise<RestoreSnapshotResponse> {
      return request(`/users/me/snapshots/${enc(id)}/restore`, {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(TRAINING_DATA_TIMEOUT_MS),
      });
    },
    /** Deletes a snapshot now. One that's already gone counts as deleted. */
    deleteSnapshot(id: string): Promise<void> {
      return requestVoidIdempotent(`/users/me/snapshots/${enc(id)}`, { method: 'DELETE', cache: 'no-store' });
    },
    /** How a snapshot's sets split into parts, as `fetchLiftRecordExportParts` lists them. */
    fetchSnapshotLiftRecordParts(id: string): Promise<LiftRecordExportPartsResponse> {
      return request(`/users/me/snapshots/${enc(id)}/lift-records/parts`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(TRAINING_DATA_TIMEOUT_MS),
      });
    },
    /** One part of a snapshot's sets as CSV. */
    downloadSnapshotLiftRecords(id: string, part: number, split: string): Promise<Blob> {
      return requestBlob(
        `/users/me/snapshots/${enc(id)}/lift-records${exportQuery({ part, split })}`,
        TRAINING_DATA_TIMEOUT_MS,
      );
    },
    fetchUserSettings(): Promise<UserSettingsResponse> {
      return request('/users/me/settings', { cache: 'no-store' });
    },
    updateUserSettings(body: UpdateUserSettingsRequest): Promise<UserSettingsResponse> {
      return request('/users/me/settings', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },

    // -- Programs (switch + custom) ---------------------------------------
    switchProgram(programId: string): Promise<SwitchProgramResponse> {
      return request(`/programs/${enc(programId)}/switch`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
        cache: 'no-store',
      });
    },
    fetchCustomPrograms(): Promise<CustomProgramSummaryResponse[]> {
      return request('/programs/custom', { cache: 'no-store' });
    },
    /** The programs holding the user's sets, the non-cycle one aside (#1454). */
    fetchRecordedPrograms(): Promise<string[]> {
      return request('/users/me/recorded-programs', { cache: 'no-store' });
    },
    fetchCustomProgram(id: string): Promise<CustomProgramResponse> {
      return request(`/programs/custom/${enc(id)}`, { cache: 'no-store' });
    },
    createCustomProgram(body: CreateCustomProgramRequest): Promise<CustomProgramResponse> {
      return request('/programs/custom', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    updateCustomProgram(
      id: string,
      body: UpdateCustomProgramRequest,
    ): Promise<CustomProgramResponse> {
      return request(`/programs/custom/${enc(id)}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    deleteCustomProgram(id: string): Promise<void> {
      return requestVoidIdempotent(`/programs/custom/${enc(id)}`, {
        method: 'DELETE',
        cache: 'no-store',
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
