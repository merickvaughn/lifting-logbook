import type {
  BodyWeightResponse,
  CreateCustomLiftRequest,
  CreateCustomProgramRequest,
  CreateLiftOverrideRequest,
  CreateLiftRecordRequest,
  CustomLiftResponse,
  CustomProgramResponse,
  CustomProgramSummaryResponse,
  CycleDashboardResponse,
  ImportCommitResponse,
  ImportError,
  ImportKind,
  ImportLiftRecordsResponse,
  ImportPreviewResponse,
  ImportUndoResponse,
  LiftMetadataResponse,
  LiftOverrideResponse,
  LiftingProgramSpecResponse,
  LiftRecordResponse,
  PatchLiftMetadataRequest,
  RecordBodyWeightRequest,
  RescheduleRequest,
  StrengthGoalResponse,
  SwitchProgramResponse,
  TrainingMaxHistoryResponse,
  TrainingMaxResponse,
  UpdateCustomProgramRequest,
  UpdateLiftRecordRequest,
  UpdateTrainingMaxesRequest,
  UpdateUserSettingsRequest,
  UpsertStrengthGoalRequest,
  UserSettingsResponse,
  WorkoutResponse,
} from '@lifting-logbook/types';

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

// Smart-import endpoint path with mode + optional destination override. Returned
// relative (rawFetch prepends baseUrl).
function importPath(
  program: string,
  mode: 'preview' | 'commit',
  destination?: ImportKind,
  opts?: CommitImportOpts,
): string {
  const params = new URLSearchParams({ mode });
  if (destination) params.set('destination', destination);
  if (opts?.overrides && Object.keys(opts.overrides).length > 0) {
    params.set('overrides', JSON.stringify(opts.overrides));
  }
  if (opts?.excludeKeys && opts.excludeKeys.length > 0) {
    params.set('excludeKeys', opts.excludeKeys.join(','));
  }
  if (opts?.liftOverrides && Object.keys(opts.liftOverrides).length > 0) {
    params.set('liftOverrides', JSON.stringify(opts.liftOverrides));
  }
  if (opts?.splitDest) {
    params.set('splitDest', '1');
  }
  return `/programs/${enc(program)}/import?${params.toString()}`;
}

/** Phase 3 options for commitImport. */
export interface CommitImportOpts {
  /** Map sourceHeader → destinationField to rename non-standard columns before parsing. */
  overrides?: Record<string, string>;
  /** Natural keys of rows to exclude from the commit. */
  excludeKeys?: string[];
  /** Map of 1-based CSV row index → canonical lift id for ambiguous rows. */
  liftOverrides?: Record<number, string>;
  /** When true, 1RM lift-record rows are split to Training Maxes. */
  splitDest?: boolean;
}

// Carries the upstream HTTP status alongside the message so a caller that needs
// to distinguish failure classes (e.g. 401/403 auth failures vs. a generic 500)
// can do so without re-parsing the message string. Currently thrown only by
// requestVoidIdempotent — the other request helpers can adopt this if a caller
// needs it.
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

// NestJS ValidationPipe returns { statusCode, message: string | string[], error }.
// Surface that detail so error UIs can show actionable text instead of just
// "Request failed: 400".
async function extractErrorMessage(res: Response, path: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join('; ');
    if (typeof body.message === 'string') return body.message;
  } catch {
    // fall through to generic
  }
  return `API ${res.status} ${res.statusText} for ${path}`;
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
    if (!res.ok) throw new Error(await extractErrorMessage(res, path));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // Like request but returns null on 404 (and 204) instead of throwing.
  async function requestNullable<T>(path: string, init?: FetchInit): Promise<T | null> {
    const res = await rawFetch(path, init);
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(await extractErrorMessage(res, path));
    return (await res.json()) as T;
  }

  // Like request but returns null on 409 Conflict instead of throwing.
  // Use for POST operations that are idempotent by intent — where a conflict
  // means the resource already exists in the desired state and the caller
  // doesn't need to know why (only initializeCycle uses this — a single
  // conflict cause, "a cycle already exists").
  async function requestOrConflict<T>(path: string, init?: FetchInit): Promise<T | null> {
    const res = await rawFetch(path, init);
    if (res.status === 409) return null;
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw new Error(await extractErrorMessage(res, path));
    return (await res.json()) as T;
  }

  // Like requestOrConflict, but surfaces the 409 body's message instead of
  // discarding it. Use when an endpoint can 409 for more than one reason and
  // a caller must tell them apart — e.g. custom-lift creation 409s both for
  // a duplicate name (CustomLiftConflictError) and for a name that shadows a
  // built-in canonical alias (ReservedLiftNameConflictError); collapsing
  // both to bare `null` left a caller unable to state the true cause and
  // reusing one error's wording for the other's conflict was simply false
  // (#917). initializeCycle deliberately keeps using requestOrConflict
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
    if (!res.ok) throw new Error(await extractErrorMessage(res, path));
    return { ok: true, data: (await res.json()) as T };
  }

  // Void request that treats 404 as success — for idempotent deletes, where an
  // already-absent resource is the desired end state.
  async function requestVoidIdempotent(path: string, init?: FetchInit): Promise<void> {
    const res = await rawFetch(path, init);
    if (!res.ok && res.status !== 404) {
      throw new ApiClientError(await extractErrorMessage(res, path), res.status);
    }
  }

  return {
    // -- Cycles ------------------------------------------------------------
    fetchCycleDashboard(program: string): Promise<CycleDashboardResponse | null> {
      return requestNullable(`/programs/${enc(program)}/cycles/current`, { cache: 'no-store' });
    },
    createCycle(programId: string): Promise<CycleDashboardResponse> {
      return request(`/programs/${enc(programId)}/cycles`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
        cache: 'no-store',
      });
    },
    // Returns null when a cycle already exists (409) — the caller should treat
    // null as "already initialized" and redirect rather than error.
    initializeCycle(
      programId: string,
      options: { cycleDate?: string } = {},
    ): Promise<CycleDashboardResponse | null> {
      return requestOrConflict(`/programs/${enc(programId)}/cycles/initialize`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(options),
        cache: 'no-store',
      });
    },
    // Idempotent delete: a 404 (no existing cycle) is treated as success, matching
    // deleteStrengthGoal/deleteCustomProgram below.
    deleteCurrentCycle(programId: string): Promise<void> {
      return requestVoidIdempotent(`/programs/${enc(programId)}/cycles/current`, {
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
      cycleNum: number,
      workoutNum: number,
      newDate: string,
    ): Promise<void> {
      // Typed against the shared contract so a change to RescheduleRequest surfaces
      // here at compile time rather than as a silently malformed request body.
      const body: RescheduleRequest = { newDate };
      return request(
        `/programs/${enc(program)}/cycles/${cycleNum}/workouts/${workoutNum}/reschedule`,
        { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body), cache: 'no-store' },
      );
    },
    skipWorkout(
      program: string,
      cycleNum: number,
      workoutNum: number,
      reason?: string,
    ): Promise<void> {
      return request(
        `/programs/${enc(program)}/cycles/${cycleNum}/workouts/${workoutNum}/skip`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(reason !== undefined ? { reason } : {}),
          cache: 'no-store',
        },
      );
    },
    unskipWorkout(program: string, cycleNum: number, workoutNum: number): Promise<void> {
      return request(
        `/programs/${enc(program)}/cycles/${cycleNum}/workouts/${workoutNum}/skip`,
        { method: 'DELETE', cache: 'no-store' },
      );
    },

    // -- Lift records ------------------------------------------------------
    fetchLiftRecords(program: string): Promise<LiftRecordResponse[]> {
      return request(`/programs/${enc(program)}/lift-records`, { cache: 'no-store' });
    },
    createLiftRecord(program: string, body: CreateLiftRecordRequest): Promise<LiftRecordResponse> {
      return request(`/programs/${enc(program)}/lift-records`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    },
    updateLiftRecord(
      program: string,
      id: string,
      body: UpdateLiftRecordRequest,
    ): Promise<LiftRecordResponse> {
      return request(`/programs/${enc(program)}/lift-records/${enc(id)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
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
      const body = (await res.json()) as { errors?: ImportError[] };
      return {
        ok: false,
        errors: body.errors ?? [{ row: 0, code: 'UNEXPECTED_ERROR', message: `Unexpected error (HTTP ${res.status})` }],
      };
    },

    // -- Smart import (classify → preview → commit any CSV) ----------------
    /**
     * Smart Import — classify + preview a CSV without writing (#477). Pass a
     * `destination` to override the classifier (e.g. after a low-confidence pick).
     */
    async previewImport(
      program: string,
      file: File,
      destination?: ImportKind,
    ): Promise<ImportPreviewResponse> {
      const form = new FormData();
      form.append('file', file);
      const res = await rawFetch(importPath(program, 'preview', destination), {
        method: 'POST',
        body: form,
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
    ): Promise<
      { ok: true; data: ImportCommitResponse } | { ok: false; errors: ImportError[] }
    > {
      const form = new FormData();
      form.append('file', file);
      const res = await rawFetch(importPath(program, 'commit', destination, opts), {
        method: 'POST',
        body: form,
        cache: 'no-store',
      });
      if (res.ok) {
        return { ok: true, data: (await res.json()) as ImportCommitResponse };
      }
      const body = (await res.json().catch(() => ({}))) as { errors?: ImportError[] };
      return {
        ok: false,
        errors: body.errors ?? [{ row: 0, code: 'UNEXPECTED_ERROR', message: `Unexpected error (HTTP ${res.status})` }],
      };
    },

    /**
     * Phase 3: Undo a committed import by its batch ID. Restores prior values for
     * updated records, deletes newly created rows, and skips rows edited since import.
     */
    async undoImport(program: string, batchId: string): Promise<ImportUndoResponse> {
      const res = await rawFetch(`/programs/${enc(program)}/import/${enc(batchId)}/undo`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`Undo import failed (HTTP ${res.status})`);
      }
      return (await res.json()) as ImportUndoResponse;
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
      cycleNum: number,
      workoutNum: number,
      body: CreateLiftOverrideRequest,
    ): Promise<LiftOverrideResponse> {
      return request(
        `/programs/${enc(program)}/cycles/${cycleNum}/workouts/${workoutNum}/lift-overrides`,
        { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), cache: 'no-store' },
      );
    },
    deleteLiftOverride(
      program: string,
      cycleNum: number,
      workoutNum: number,
      lift: string,
    ): Promise<void> {
      return request(
        `/programs/${enc(program)}/cycles/${cycleNum}/workouts/${workoutNum}/lift-overrides/${enc(lift)}`,
        { method: 'DELETE', cache: 'no-store' },
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

    // -- User settings -----------------------------------------------------
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
