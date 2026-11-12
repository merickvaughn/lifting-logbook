import type {
  BodyWeightResponse,
  CreateCustomLiftRequest,
  CreateFocusBlockRequest,
  CreateCustomProgramRequest,
  CreateLiftModificationRequest,
  CreateLiftOverrideRequest,
  CreateLiftRecordRequest,
  CustomLiftResponse,
  CustomProgramResponse,
  CustomProgramSummaryResponse,
  FocusBlockResponse,
  FocusBlockSummaryResponse,
  FocusDayPlanResponse,
  FocusDayState,
  FocusSettingsResponse,
  ReorderFocusBlocksRequest,
  MacrocycleDashboardResponse,
  ImportCommitResponse,
  ImportDryRunResponse,
  ImportError,
  ImportKind,
  ImportLiftRecordsResponse,
  GoogleSheetImportRequest,
  GoogleSheetWorkbookResponse,
  ImportPreviewResponse,
  ImportUndoResponse,
  LiftMetadataResponse,
  LiftModificationResponse,
  LiftOverrideResponse,
  LiftingProgramSpecResponse,
  LiftRecordResponse,
  MacrocycleSummaryResponse,
  ModificationMaxResponse,
  PatchLiftMetadataRequest,
  PutModificationMaxRequest,
  RecordBodyWeightRequest,
  RescheduleRequest,
  StrengthGoalResponse,
  SwitchProgramResponse,
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
} from '@lifting-logbook/types';
import { MACROCYCLE_ID_HEADER } from '@lifting-logbook/types';

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
const DATA_EXPORT_TIMEOUT_MS = 60_000;

// Smart-import endpoint path with mode + optional destination override. Returned
// relative (rawFetch prepends baseUrl).
function importPath(
  program: string,
  mode: 'preview' | 'commit' | 'dry-run',
  destination?: ImportKind,
  opts?: Pick<CommitImportOpts, 'overrides' | 'splitDest'>,
): string {
  const params = new URLSearchParams({ mode });
  if (destination) params.set('destination', destination);
  if (opts?.overrides && Object.keys(opts.overrides).length > 0) {
    params.set('overrides', JSON.stringify(opts.overrides));
  }
  if (opts?.splitDest) {
    params.set('splitDest', '1');
  }
  return `/programs/${enc(program)}/import?${params.toString()}`;
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
  const message =
    body.code === 'macrocycle-busy' && typeof body.message === 'string' ? body.message : `Unexpected error (HTTP ${status})`;
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
      // Bound every request that doesn't already carry its own signal (#922) — no
      // call site passes one today, so this always applies in practice, but a
      // future call site's own signal (e.g. a per-row Cancel affordance) takes
      // precedence rather than being silently clobbered.
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
    // Idempotent delete: a 404 (no existing macrocycle) is treated as success, matching
    // deleteStrengthGoal/deleteCustomProgram below.
    deleteCurrentMacrocycle(programId: string): Promise<void> {
      return requestVoidIdempotent(`/programs/${enc(programId)}/macrocycles/current`, {
        method: 'DELETE',
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
     * discriminated union so callers handle validation errors without catching.
     * Phase 3: pass `opts` for column overrides, row exclusions, lift remapping, or
     * 1RM split routing.
     */
    async commitImport(
      program: string,
      file: File,
      destination: ImportKind,
      opts?: CommitImportOpts,
    ): Promise<ImportCommitResult<ImportCommitResponse>> {
      const res = await rawFetch(importPath(program, 'commit', destination, opts), {
        method: 'POST',
        body: importForm(file, opts),
        cache: 'no-store',
      });
      if (res.ok) {
        return { ok: true, data: (await res.json()) as ImportCommitResponse };
      }
      const body = (await res.json().catch(() => ({}))) as { errors?: ImportError[]; code?: unknown; message?: unknown };
      return { ok: false, errors: importFailureErrors(res.status, body) };
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
     */
    async undoImport(program: string, batchId: string): Promise<ImportUndoResponse> {
      const path = `/programs/${enc(program)}/import/${enc(batchId)}/undo`;
      const res = await rawFetch(path, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        // A 409 macrocycle-busy (#1198) carries a message asking to try again. Anything else
        // keeps the generic message the import wizard shows, with the status, code and body.
        const err = await readError(res, path);
        if (err.code === 'macrocycle-busy') throw err;
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
    async downloadDataExport(): Promise<Blob> {
      const path = '/users/me/export';
      const res = await rawFetch(path, {
        cache: 'no-store',
        signal: AbortSignal.timeout(DATA_EXPORT_TIMEOUT_MS),
      });
      if (!res.ok) throw await readError(res, path);
      return res.blob();
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
