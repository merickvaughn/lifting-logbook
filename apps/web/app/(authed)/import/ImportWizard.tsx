'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  ColumnMapping,
  CustomLiftResponse,
  CustomProgramSummaryResponse,
  ImportCommitResponse,
  ImportDelta,
  ImportError,
  ImportKind,
  ImportPreviewResponse,
  ImportUndoResponse,
  LiftClassification,
  WeightUnit,
} from '@lifting-logbook/types';
import { ALL_SLOT_MAP_ALIASES, formatWeight } from '@lifting-logbook/core';
import {
  commitImport,
  createCustomLift,
  fetchCustomLifts,
  previewImport,
  undoImport,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { Step, STEP_LABELS } from './steps';
import styles from './import.module.css';

type ReviewFilter = 'all' | 'new' | 'updates' | 'skips' | 'incomplete' | 'ambiguous';
type EditableMax = { lift: string; weight: string };

// Per-row transient state for the "create new exercise" affordance on an
// ambiguous row (issue #911) — keyed by rowIndex, mirroring liftOverrides.
type CreateLiftDraft = {
  classification: LiftClassification | null;
  busy: boolean;
  error: string | null;
};

// The preview response disambiguates ImportDelta.key with a `#N` suffix when
// the same natural key is yielded more than once in one batch (issue #884),
// so React list identity and this component's Set-based select/exclude state
// never collide across the original and an in-batch duplicate. The server's
// excludeKeys contract still matches on the bare natural key (it can't
// distinguish which of two same-keyed rows a suffix would refer to), so strip
// the suffix before sending — this keeps this component's original
// coarse-by-natural-key exclude semantics rather than silently excluding
// nothing when a duplicate row's checkbox is used.
function stripDeltaKeySuffix(key: string): string {
  return key.replace(/#\d+$/, '');
}

function buildTrainingMaxesCsv(rows: EditableMax[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = rows
    .filter((r) => Number(r.weight) > 0)
    .map((r) => `${today},"${r.lift.replace(/"/g, '""')}",${Number(r.weight)}`);
  return ['Date Updated,Lift,Weight', ...lines].join('\n');
}

const KIND_LABEL: Record<ImportKind, string> = {
  'lift-records': 'Lift History',
  'training-maxes': 'Training Maxes',
  'strength-goals': 'Strength Goals',
  'program-spec': 'Program',
};

const ALL_KINDS: ImportKind[] = [
  'lift-records',
  'training-maxes',
  'strength-goals',
  'program-spec',
];

type FieldOption = { key: string; label: string };

const KIND_FIELDS: Record<ImportKind, FieldOption[]> = {
  'lift-records': [
    { key: 'program', label: 'Program' },
    { key: 'cycleNum', label: 'Cycle #' },
    { key: 'workoutNum', label: 'Workout #' },
    { key: 'date', label: 'Date' },
    { key: 'lift', label: 'Lift' },
    { key: 'setNum', label: 'Set #' },
    { key: 'weight', label: 'Weight' },
    { key: 'reps', label: 'Reps' },
    { key: 'amrap', label: 'AMRAP' },
    { key: 'notes', label: 'Notes' },
  ],
  'training-maxes': [
    { key: 'lift', label: 'Lift' },
    { key: 'weight', label: 'Weight' },
    { key: 'dateUpdated', label: 'Date Updated' },
  ],
  'strength-goals': [],
  'program-spec': [
    { key: 'week', label: 'Week' },
    { key: 'offset', label: 'Offset' },
    { key: 'lift', label: 'Lift' },
    { key: 'increment', label: 'Increment' },
    { key: 'order', label: 'Order' },
    { key: 'sets', label: 'Sets' },
    { key: 'reps', label: 'Reps' },
    { key: 'amrap', label: 'AMRAP?' },
    { key: 'warmUpPct', label: 'Warm-Up %' },
    { key: 'wtDecrementPct', label: 'WT Decrement %' },
    { key: 'activation', label: 'Activation' },
    { key: 'weekType', label: 'Week Type' },
  ],
};

function getAllFieldsForKind(kind: ImportKind): FieldOption[] {
  return KIND_FIELDS[kind] ?? [];
}

// Exhaustive, not hand-duplicated per chip (issue #911 review) — a future
// LiftClassification value renders automatically instead of silently being
// unreachable in the "create new exercise" affordance.
const LIFT_CLASSIFICATIONS: { value: LiftClassification; label: string }[] = [
  { value: 'compound', label: 'Compound' },
  { value: 'accessory', label: 'Accessory' },
];

function bucketClass(bucket: 'high' | 'medium' | 'low'): string {
  return bucket === 'high'
    ? styles.bucketHigh ?? ''
    : bucket === 'medium'
      ? styles.bucketMedium ?? ''
      : styles.bucketLow ?? '';
}

function filterDeltas(deltas: ImportDelta[], filter: ReviewFilter): ImportDelta[] {
  if (filter === 'all') return deltas;
  if (filter === 'incomplete') return deltas.filter((d) => d.status === 'incomplete');
  if (filter === 'ambiguous') return deltas.filter((d) => d.status === 'ambiguous');
  if (filter === 'new') return deltas.filter((d) => d.kind === 'create' && !d.status);
  if (filter === 'updates') return deltas.filter((d) => d.kind === 'update' && !d.status);
  if (filter === 'skips') return deltas.filter((d) => d.kind === 'skip');
  return deltas;
}

export function ImportWizard({
  programs,
  customLifts: initialCustomLifts,
  unit = 'lbs',
}: {
  programs: CustomProgramSummaryResponse[];
  /**
   * The user's custom lifts, for the REVIEW step's ambiguous-row remap
   * datalist (#911). Required, not optional-with-a-[]-default: silently
   * omitting it is indistinguishable from "this user has no custom lifts"
   * and reproduces the exact bug this prop exists to fix (review finding —
   * every caller must make an explicit choice, even if that choice is `[]`).
   */
  customLifts: CustomLiftResponse[];
  /**
   * Display-only preference for a read-only conversion hint. Imported
   * training-max values are directly-known (see
   * docs/standards/training-max-precision.md) and always committed in lbs —
   * this API has no real per-record unit storage — so the editable weight
   * value itself is never converted.
   */
  unit?: WeightUnit;
}) {
  const [step, setStep] = useState<typeof Step[keyof typeof Step]>(Step.SOURCE);
  const [programId, setProgramId] = useState<string>(programs[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [commitResult, setCommitResult] = useState<ImportCommitResponse | null>(null);
  const [commitErrors, setCommitErrors] = useState<ImportError[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Phase 3 state
  const [reviewMaxes, setReviewMaxes] = useState<EditableMax[] | null>(null);
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [liftOverrides, setLiftOverrides] = useState<Map<number, string>>(new Map());
  // Seeded from the server-fetched prop, then grown locally as the user creates
  // exercises inline during this session (#911) — no page reload needed to see
  // a just-created lift reflected in the remap datalist.
  const [customLifts, setCustomLifts] = useState<CustomLiftResponse[]>(initialCustomLifts);
  const [createDrafts, setCreateDrafts] = useState<Map<number, CreateLiftDraft>>(new Map());
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const lastSelectedKey = useRef<string | null>(null);
  // Bumped every time analyze() stores a new preview. handleCreateLift reads
  // this via a ref (not a closure-captured value) so it can detect — even
  // after an `await` — that the preview it was resolving overrides for has
  // since been discarded (Back → re-pick-destination mid-request) and bail
  // out instead of writing overrides keyed to rows that no longer exist in
  // the current preview (#911 review, second pass).
  const previewGeneration = useRef(0);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [undoResult, setUndoResult] = useState<ImportUndoResponse | null>(null);

  // Column mapping overrides from MAP_COLUMNS step
  const [columnOverrides, setColumnOverrides] = useState<Map<string, string>>(new Map());

  const destination = preview?.destination ?? null;
  const previewBody = preview?.preview ?? null;

  function mappingKey(m: ColumnMapping): string {
    return m.sourceHeader || `__req__:${m.destinationField}`;
  }

  const effectiveMappings: ColumnMapping[] = (preview?.columnMappings ?? []).map((m) =>
    columnOverrides.has(mappingKey(m))
      ? { ...m, destinationField: columnOverrides.get(mappingKey(m)) ?? m.destinationField, confidence: 1 }
      : m,
  );

  const allRequiredMapped = effectiveMappings
    .filter((m) => m.required)
    .every((m) => m.destinationField !== '' && m.confidence > 0);

  // Derived: column overrides as a plain Record for the commit call
  const columnOverridesRecord: Record<string, string> = {};
  for (const [src, dest] of columnOverrides.entries()) {
    if (src && !src.startsWith('__req__:')) {
      columnOverridesRecord[src] = dest;
    }
  }

  // REVIEW filter chips — only show incomplete/ambiguous when rows exist
  const hasIncomplete = (previewBody?.deltas ?? []).some((d) => d.status === 'incomplete');
  const hasAmbiguous = (previewBody?.deltas ?? []).some((d) => d.status === 'ambiguous');

  // Filtered deltas for the REVIEW table
  const visibleDeltas = useMemo(
    () => filterDeltas(previewBody?.deltas ?? [], reviewFilter),
    [previewBody, reviewFilter],
  );

  // Case-insensitive lowercase set of every built-in canonical alias — used to
  // (a) keep a custom lift that shadows one out of the remap datalist (picking
  // it would silently resolve to the canonical built-in instead, per
  // buildEffectiveSlotMap's own DEFAULT_SLOT_MAP-wins-on-collision precedence)
  // and (b) build knownLiftNamesCanonical below (#911 review, second pass).
  const defaultAliasesLower = useMemo(
    () => new Set(ALL_SLOT_MAP_ALIASES.map((a) => a.toLowerCase())),
    [],
  );

  // Case-insensitive lookup (lowercased text -> canonical-cased form) of every
  // value an ambiguous-row remap can already resolve to without creating
  // anything new (issue #911). Exact-case-only checking meant a case variant
  // of a valid name (e.g. "squat" for "Squat") read as unrecognized, offering
  // to create a duplicate lift that DEFAULT_SLOT_MAP's collision precedence
  // then permanently shadowed by exact case only — silently fragmenting that
  // lift's history, since the server's own slot-map lookup is exact-case too
  // (review finding on #911's PR, second pass). Built-in aliases are added
  // first so they always win a case-insensitive collision with a custom lift's
  // name, mirroring buildEffectiveSlotMap's own precedence rule server-side —
  // though the server also now rejects creating such a shadowing custom lift
  // in the first place (CustomLiftController.create/update).
  const knownLiftNamesCanonical = useMemo(() => {
    const map = new Map<string, string>();
    for (const alias of ALL_SLOT_MAP_ALIASES) {
      map.set(alias.toLowerCase(), alias);
    }
    for (const lift of customLifts) {
      const nameKey = lift.name.toLowerCase();
      if (!map.has(nameKey)) map.set(nameKey, lift.name);
      map.set(lift.id.toLowerCase(), lift.id);
    }
    return map;
  }, [customLifts]);

  async function analyze(override?: ImportKind): Promise<ImportPreviewResponse | null> {
    if (!programId || !file) return null;
    setError(null);
    setBusy(true);
    try {
      const res = await previewImport(programId, file, override);
      setPreview(res);
      previewGeneration.current += 1;
      // Every piece of state keyed to the previous preview's deltas/rows must
      // be cleared when analyze() replaces them — reachable via the Back →
      // re-pick-destination path (handlePickDestination). liftOverrides and
      // createDrafts are keyed by rowIndex; a stale entry surviving would
      // drive a render-time decision on an unrelated row of the new preview
      // (suppressing or fabricating its create-new affordance) and still be
      // sent as its commit override. excludedKeys/selectedKeys are keyed by
      // delta.key, which can collide across previews too (e.g. ambiguous rows
      // always key as `__ambiguous_<rowIndex>`, so file A's row 1 and file B's
      // row 1 collide) — an uncleared exclude would then silently drop an
      // unrelated row from the new file's import with nothing in the UI
      // explaining why. reviewMaxes is the training-maxes REVIEW step's own
      // editable copy of the previous preview's deltas (#911 review, second
      // pass — the first-pass fix only cleared the first two).
      setLiftOverrides(new Map());
      setCreateDrafts(new Map());
      setExcludedKeys(new Set());
      setSelectedKeys(new Set());
      lastSelectedKey.current = null;
      setReviewMaxes(null);
      return res;
    } catch (e) {
      logClientError('previewImport', e, { programId });
      setError(e instanceof Error ? e.message : 'Preview failed');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleAnalyze() {
    setStep(Step.ANALYZING);
    const res = await analyze();
    setStep(res ? Step.CLASSIFY : Step.SOURCE);
  }

  async function handlePickDestination(kind: ImportKind) {
    setColumnOverrides(new Map());
    setStep(Step.ANALYZING);
    const res = await analyze(kind);
    setStep(res ? Step.MAP_COLUMNS : Step.CLASSIFY);
  }

  function enterReview() {
    // Initialize TM editable list from preview deltas (create + update rows)
    if (destination === 'training-maxes' && previewBody && reviewMaxes === null) {
      setReviewMaxes(
        previewBody.deltas
          .filter((d) => d.kind === 'create' || d.kind === 'update')
          .map((d) => ({ lift: d.label, weight: d.after ?? '' })),
      );
    }
    setReviewFilter('all');
    setSelectedKeys(new Set());
    lastSelectedKey.current = null;
    setStep(Step.REVIEW);
  }

  function handleDeltaCheckbox(key: string, shiftHeld: boolean, deltas: ImportDelta[]) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastSelectedKey.current && lastSelectedKey.current !== key) {
        const keys = deltas.map((d) => d.key);
        const a = keys.indexOf(lastSelectedKey.current);
        const b = keys.indexOf(key);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) {
          const k = keys[i];
          if (k) next.add(k);
        }
      } else {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      }
      lastSelectedKey.current = key;
      return next;
    });
  }

  function bulkExcludeSelected() {
    setExcludedKeys((prev) => {
      const next = new Set(prev);
      for (const k of selectedKeys) next.add(k);
      return next;
    });
    setSelectedKeys(new Set());
  }

  // Toggles the classification chip for an in-progress "create new exercise" draft
  // (issue #911). Clicking the already-selected chip clears the choice.
  function setDraftClassification(rowIndex: number, classification: LiftClassification) {
    setCreateDrafts((prev) => {
      const next = new Map(prev);
      const existing = next.get(rowIndex) ?? { classification: null, busy: false, error: null };
      next.set(rowIndex, {
        ...existing,
        classification: existing.classification === classification ? null : classification,
        error: null,
      });
      return next;
    });
  }

  function clearCreateDraft(rowIndex: number) {
    setCreateDrafts((prev) => {
      const next = new Map(prev);
      next.delete(rowIndex);
      return next;
    });
  }

  function setCreateDraftError(rowIndex: number, error: string) {
    setCreateDrafts((prev) => {
      const next = new Map(prev);
      const existing = next.get(rowIndex);
      next.set(rowIndex, { classification: existing?.classification ?? null, busy: false, error });
      return next;
    });
  }

  // Resolves every ambiguous delta whose original (unedited) CSV text matches
  // matchOriginalLift to liftId — not just the row that triggered creation.
  // A recurring unrecognized name (the exact scenario issue #911 was filed
  // over — one CSV export, one name, many set rows) would otherwise force the
  // user to repeat "create new" once per occurrence.
  //
  // triggeringRowIndex always resolves unconditionally — it's the row whose
  // "Create" click caused this call, so it must land on liftId regardless of
  // whatever (if anything) it held before. Every OTHER matching row only
  // resolves if it's untouched or already agrees with liftId: batch-resolve is
  // a convenience for identical-text rows the user hasn't separately edited,
  // not a license to silently overwrite a different, deliberate remap on a
  // row whose input still visibly shows that different choice (review finding
  // on #911's PR — the uncontrolled input let the two silently diverge).
  function applyResolvedLiftToMatchingRows(
    matchOriginalLift: string,
    liftId: string,
    triggeringRowIndex: number,
  ) {
    const deltas = previewBody?.deltas ?? [];
    setLiftOverrides((prev) => {
      const next = new Map(prev);
      for (const delta of deltas) {
        if (
          delta.status === 'ambiguous' &&
          delta.rowIndex !== undefined &&
          delta.originalLift === matchOriginalLift
        ) {
          const existing = next.get(delta.rowIndex);
          if (
            delta.rowIndex === triggeringRowIndex ||
            existing === undefined ||
            existing === liftId
          ) {
            next.set(delta.rowIndex, liftId);
          }
        }
      }
      return next;
    });
  }

  // Creates `name` as a new custom lift and resolves this (and every matching)
  // ambiguous row to it. Only ever fires on an explicit click (issue #911) —
  // never automatically from typing — since a value that already exactly
  // matches a known name would either 409 or silently create an unreachable
  // shadowed lift (buildEffectiveSlotMap lets DEFAULT_SLOT_MAP win on collision).
  async function handleCreateLift(
    name: string,
    matchOriginalLift: string,
    rowIndex: number,
    classification: LiftClassification,
  ) {
    // Captured before any `await` — read via the ref (not a closure-captured
    // value) after each `await` below to detect a preview replaced mid-request
    // (Back → re-pick-destination while this create is in flight) and bail out
    // rather than writing overrides keyed to rows from a discarded preview
    // (#911 review, second pass).
    const startGeneration = previewGeneration.current;

    setCreateDrafts((prev) => {
      const next = new Map(prev);
      const existing = next.get(rowIndex) ?? { classification, busy: false, error: null };
      next.set(rowIndex, { ...existing, classification, busy: true, error: null });
      return next;
    });

    try {
      const created = await createCustomLift({ name, classification });
      if (previewGeneration.current !== startGeneration) return; // preview discarded mid-request
      if (created === null) {
        // 409 — a lift with this name already exists. Re-fetch the live server
        // list rather than searching the render-scope `customLifts` closure,
        // which can be stale: two ambiguous rows sharing this name each get
        // their own independently-enabled "Create" button (busy only guards
        // its own row), so a second click before the first resolves would
        // otherwise find no local match even for a lift this session just
        // created — and a genuine cross-tab creation was never in the local
        // list at all (#911 review).
        let latest: CustomLiftResponse[] | null = null;
        let refetchFailed = false;
        try {
          latest = await fetchCustomLifts();
          if (previewGeneration.current !== startGeneration) return;
          setCustomLifts(latest);
        } catch (fetchErr) {
          refetchFailed = true;
          // Never include `name` — free text lifted straight from the user's
          // uploaded CSV (or typed into the remap input) — in logClientError's
          // context. It beacons to /api/client-errors and becomes a *retained*
          // OTel span in Grafana; this project's own Observability convention
          // (CLAUDE.md, tracking #783) requires ids/actions only, never request
          // body content (#911 review, second pass).
          logClientError('fetchCustomLifts', fetchErr, { programId, rowIndex });
        }
        const existing = latest?.find((c) => c.name === name);
        if (existing) {
          applyResolvedLiftToMatchingRows(matchOriginalLift, existing.id, rowIndex);
          clearCreateDraft(rowIndex);
          return;
        }
        // Distinguish "confirmed it already exists" from "couldn't confirm
        // either way" — the refetch itself failing is not the same claim as a
        // genuine name collision, and telling the user the wrong one sends
        // them down the wrong recovery path (#911 review, second pass).
        setCreateDraftError(
          rowIndex,
          refetchFailed
            ? "Couldn't confirm whether this name already exists — try again."
            : 'An exercise with this name already exists.',
        );
        return;
      }
      setCustomLifts((prev) => [...prev, created]);
      applyResolvedLiftToMatchingRows(matchOriginalLift, created.id, rowIndex);
      clearCreateDraft(rowIndex);
    } catch (e) {
      // Never include `name` — see the logClientError comment above.
      logClientError('createCustomLift', e, { programId, rowIndex });
      setCreateDraftError(rowIndex, e instanceof Error ? e.message : 'Failed to create exercise');
    }
  }

  async function handleCommit() {
    if (!programId || !file || !destination) return;
    setCommitErrors(null);
    setBusy(true);

    let commitFile = file;

    try {
      let result: { ok: true; data: ImportCommitResponse } | { ok: false; errors: ImportError[] };

      if (destination === 'training-maxes' && reviewMaxes !== null) {
        // Rebuild CSV from the edited maxes list so that inline weight edits and excluded rows
        // are authoritative at commit time. excludedKeys is enforced here (via filter) rather
        // than via the server-side excludeKeys param, because the rebuilt CSV already omits
        // those rows — passing excludeKeys on top would be redundant and error-prone.
        const activeMaxes = reviewMaxes.filter((r) => !excludedKeys.has(r.lift));
        const csv = buildTrainingMaxesCsv(activeMaxes);
        commitFile = new File([csv], file.name, { type: 'text/csv' });
        result = await commitImport(programId, commitFile, destination, {
          overrides: Object.keys(columnOverridesRecord).length > 0 ? columnOverridesRecord : undefined,
        });
      } else {
        const liftOverridesRecord: Record<number, string> = {};
        // Stale entries from a *discarded* preview (e.g. an in-flight
        // create-new resolves after the user hits Back and re-picks a
        // destination mid-request) must never be sent for a row that isn't
        // even ambiguous in the CURRENT preview — d.status never changes once
        // a row is flagged ambiguous, so this set correctly identifies every
        // rowIndex that belongs to the preview actually being committed,
        // resolved or not (#911 review, second pass).
        const currentAmbiguousRowIndexes = new Set(
          (previewBody?.deltas ?? [])
            .filter((d) => d.status === 'ambiguous' && d.rowIndex !== undefined)
            .map((d) => d.rowIndex as number),
        );
        for (const [rowIdx, liftId] of liftOverrides.entries()) {
          if (!currentAmbiguousRowIndexes.has(rowIdx)) continue;
          // The controlled ambiguous-row input now stores the raw (untrimmed)
          // typed value so a just-typed trailing space isn't eaten mid-keystroke
          // — trim here, at the one place the value actually leaves the client
          // (#911 review). A no-op for the common case (a lift id or a
          // datalist-selected name, neither of which ever carries whitespace).
          const trimmed = liftId.trim();
          // Cleared by the user (backspaced to empty) — send no override for
          // this row so it's committed as still-unresolved, rather than an
          // empty string (#911 review, second pass — see the controlled-input
          // onChange handler for why liftOverrides can now hold '').
          if (!trimmed) continue;
          // A case-insensitive match against a known alias resolves to its
          // canonical casing before sending — the server's slot-map lookup is
          // exact-case, so a user who typed "squat" (matching "Squat"
          // case-insensitively) must be sent the canonical spelling, not
          // literally what they typed, or commit would fail with the same
          // "not recognized" error the create-new gate just correctly avoided
          // for them (#911 review, second pass).
          const canonical = knownLiftNamesCanonical.get(trimmed.toLowerCase());
          liftOverridesRecord[rowIdx] = canonical ?? trimmed;
        }
        result = await commitImport(programId, file, destination, {
          overrides: Object.keys(columnOverridesRecord).length > 0 ? columnOverridesRecord : undefined,
          excludeKeys: excludedKeys.size > 0 ? [...excludedKeys].map(stripDeltaKeySuffix) : undefined,
          liftOverrides: liftOverrides.size > 0 ? liftOverridesRecord : undefined,
          splitDest: preview?.split !== undefined,
        });
      }

      if (result.ok) {
        setBatchId(result.data.batchId);
        setCommitResult(result.data);
        setStep(Step.DONE);
      } else {
        setCommitErrors(result.errors);
      }
    } catch (e) {
      logClientError('commitImport', e, { programId, destination });
      setCommitErrors([
        { row: 0, message: e instanceof Error ? e.message : 'Import failed' },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    if (!programId || !batchId || undoResult !== null) return;
    setBusy(true);
    try {
      const result = await undoImport(programId, batchId);
      setUndoResult(result);
    } catch (e) {
      logClientError('undoImport', e, { programId, batchId });
      setError(e instanceof Error ? e.message : 'Undo failed');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(Step.SOURCE);
    setFile(null);
    setPreview(null);
    setCommitResult(null);
    setCommitErrors(null);
    setError(null);
    setReviewMaxes(null);
    setExcludedKeys(new Set());
    setLiftOverrides(new Map());
    // customLifts is intentionally NOT reset — any lift created this session is
    // real, persisted server-side data, not session-local UI state (#911).
    setCreateDrafts(new Map());
    setReviewFilter('all');
    setSelectedKeys(new Set());
    lastSelectedKey.current = null;
    setColumnOverrides(new Map());
    setBatchId(null);
    setUndoResult(null);
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <h1 className={styles.headerTitle}>Import a file</h1>
          <p className={styles.headerSubtitle}>
            Step {step + 1} of {STEP_LABELS.length} · {STEP_LABELS[step]}
          </p>
          <nav className={styles.progressDots} aria-label="Import progress">
            {STEP_LABELS.map((label, i) => (
              <span
                key={label}
                className={[
                  styles.dot,
                  i === step ? styles.dotActive : '',
                  i < step ? styles.dotDone : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-current={i === step ? 'step' : undefined}
                aria-label={label}
              />
            ))}
          </nav>
        </header>

        <section className={styles.body}>
          {/* ── SOURCE ── */}
          {step === Step.SOURCE && (
            <>
              <h2 className={styles.stepTitle}>Choose a file and program</h2>
              <p className={styles.stepHint}>
                Drop in any CSV — lift history, training maxes, strength goals, or a program.
                We&apos;ll figure out what it is.
              </p>
              {programs.length === 0 ? (
                <p className={styles.infoBox}>
                  You don&apos;t have a custom program yet.{' '}
                  <Link href="/programs">Create one</Link> to import into.
                </p>
              ) : (
                <div className={styles.field}>
                  <label htmlFor="import-program" className={styles.fieldLabel}>
                    Program
                  </label>
                  <select
                    id="import-program"
                    className={styles.select}
                    value={programId}
                    onChange={(e) => setProgramId(e.target.value)}
                  >
                    {programs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className={styles.field}>
                <label htmlFor="import-file" className={styles.fieldLabel}>
                  CSV file
                </label>
                <input
                  id="import-file"
                  type="file"
                  accept=".csv"
                  className={styles.fileInput}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
              {error && <p className={styles.errorNote}>{error}</p>}
            </>
          )}

          {/* ── ANALYZING ── */}
          {step === Step.ANALYZING && (
            <div className={styles.analyzing}>
              <div className={styles.spinner} aria-hidden="true" />
              <p>Analyzing your file…</p>
            </div>
          )}

          {/* ── CLASSIFY ── */}
          {step === Step.CLASSIFY && preview && (
            <>
              <h2 className={styles.stepTitle}>What we found</h2>
              {destination ? (
                <div className={styles.classifyCard}>
                  <div>
                    <span className={styles.destinationName}>
                      {KIND_LABEL[destination]}
                    </span>{' '}
                    <span className={`${styles.confidenceBadge} ${bucketClass(preview.classification.bucket)}`}>
                      {preview.classification.bucket} ·{' '}
                      {Math.round(preview.classification.confidence * 100)}%
                    </span>
                  </div>
                  {preview.classification.reasons.length > 0 && (
                    <div>
                      <p className={styles.stepHint}>Why this classification</p>
                      <ul className={styles.reasonList}>
                        {preview.classification.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {preview.classification.alternatives.length > 0 && (
                    <div>
                      <p className={styles.stepHint}>Other possibilities considered</p>
                      <ul className={styles.altList}>
                        {preview.classification.alternatives.map((a) => (
                          <li key={a.type}>
                            {KIND_LABEL[a.type]} — {Math.round(a.confidence * 100)}%
                            {a.closeCall ? ' (close call)' : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <p className={styles.stepHint}>
                    We couldn&apos;t confidently tell what this file is. Pick a destination,
                    or skip it.
                  </p>
                  <div className={styles.candidateList}>
                    {ALL_KINDS.map((kind) => {
                      const alt = preview.classification.alternatives.find((a) => a.type === kind);
                      const conf = alt ? Math.round(alt.confidence * 100) : null;
                      return (
                        <button
                          key={kind}
                          type="button"
                          className={styles.candidate}
                          onClick={() => handlePickDestination(kind)}
                        >
                          <span>{KIND_LABEL[kind]}</span>
                          {conf !== null && <span className={styles.stepHint}>{conf}%</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── MAP_COLUMNS ── */}
          {step === Step.MAP_COLUMNS && preview && destination && (
            <>
              <h2 className={styles.stepTitle}>Map columns</h2>
              {effectiveMappings.length > 0 ? (
                <>
                  <p className={styles.stepHint}>
                    We matched your CSV columns to the expected fields. Required fields are
                    marked <span className={styles.requiredStar}>★</span>. Override any mapping
                    using the dropdowns below.
                  </p>
                  {!allRequiredMapped && (
                    <div className={styles.unmappedAlert}>
                      Some required fields are not yet mapped. Assign them before continuing.
                    </div>
                  )}
                  <table className={styles.mappingTable} aria-label="Column mappings">
                    <thead>
                      <tr>
                        <th>Your column</th>
                        <th>Maps to</th>
                        <th>Confidence</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {effectiveMappings.map((m, i) => {
                        const allFields = getAllFieldsForKind(destination);
                        const confPct = Math.round(m.confidence * 100);
                        const confClass =
                          m.confidence >= 0.7
                            ? styles.confHigh
                            : m.confidence >= 0.4
                              ? styles.confMedium
                              : styles.confLow;
                        const isUnmappedRequired = m.required && (m.destinationField === '' || m.confidence === 0);

                        return (
                          <tr
                            key={`${m.sourceHeader}-${i}`}
                            className={isUnmappedRequired ? styles.unmappedRequired : ''}
                          >
                            <td>
                              {m.sourceHeader ? (
                                <span className={styles.sourceHeaderCell}>{m.sourceHeader}</span>
                              ) : (
                                <span className={styles.unmappedSourceCell}>(no match in CSV)</span>
                              )}
                              {m.required && (
                                <span className={styles.requiredStar} aria-label="required">★</span>
                              )}
                            </td>
                            <td>
                              <select
                                className={styles.mappingSelect}
                                aria-label={`Map column ${m.sourceHeader || '(unmapped)'}`}
                                value={columnOverrides.get(mappingKey(m)) ?? m.destinationField}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  const key = mappingKey(m);
                                  setColumnOverrides((prev) => {
                                    const next = new Map(prev);
                                    if (val === m.destinationField) {
                                      next.delete(key);
                                    } else {
                                      next.set(key, val);
                                    }
                                    return next;
                                  });
                                }}
                              >
                                <option value="">— unmapped —</option>
                                {allFields.map(({ key, label }) => (
                                  <option key={key} value={key}>{label}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <span className={`${styles.confidencePct} ${confClass}`}>
                                {m.sourceHeader ? `${confPct}%` : '—'}
                              </span>
                            </td>
                            <td>
                              {m.transformationNote && (
                                <span className={styles.transformNote}>{m.transformationNote}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className={styles.mappingLegend}>
                    <span className={styles.requiredStar}>★</span> = required field
                  </p>
                </>
              ) : (
                <p className={styles.infoBox}>No column information available for this file.</p>
              )}
            </>
          )}

          {/* ── REVIEW ── */}
          {step === Step.REVIEW && preview && (
            <>
              <h2 className={styles.stepTitle}>Review</h2>

              {preview.errors.length > 0 ? (
                <div className={styles.errorBox}>
                  <strong>This file has {preview.errors.length} problem(s):</strong>
                  <ul className={styles.errorList}>
                    {preview.errors.slice(0, 20).map((e, i) => (
                      <li key={`${e.row}-${e.field}-${i}`}>
                        Row {e.row}
                        {e.field ? ` · ${e.field}` : ''}: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : previewBody ? (
                <>
                  {/* Training maxes: editable list */}
                  {destination === 'training-maxes' && reviewMaxes !== null ? (
                    <>
                      <p className={styles.stepHint}>Edit weights or remove rows before committing.</p>
                      <ul className={styles.maxEditList} aria-label="Training maxes to import">
                        {reviewMaxes
                          .filter((row) => !excludedKeys.has(row.lift))
                          .map((row) => (
                            <li key={row.lift} className={styles.maxEditRow}>
                              <span className={styles.maxEditLift}>{row.lift}</span>
                              <input
                                type="number"
                                className={styles.maxEditWeight}
                                value={row.weight}
                                min={1}
                                step="0.01"
                                aria-label={`Weight for ${row.lift}`}
                                onChange={(e) =>
                                  setReviewMaxes((prev) =>
                                    prev
                                      ? prev.map((r) =>
                                          r.lift === row.lift ? { ...r, weight: e.target.value } : r,
                                        )
                                      : prev,
                                  )
                                }
                              />
                              <span className={styles.stepHint}>lbs</span>
                              {unit !== 'lbs' && row.weight !== '' && !isNaN(Number(row.weight)) && (
                                <span className={styles.stepHint}>
                                  ≈ {formatWeight(Number(row.weight), 'lbs', unit)}
                                </span>
                              )}
                              <button
                                type="button"
                                className={styles.maxEditRemove}
                                onClick={() =>
                                  setExcludedKeys((prev) => new Set([...prev, row.lift]))
                                }
                                aria-label={`Remove ${row.lift}`}
                              >
                                ×
                              </button>
                            </li>
                          ))}
                      </ul>
                      {reviewMaxes.filter((r) => !excludedKeys.has(r.lift)).length === 0 && (
                        <p className={styles.infoBox}>All rows removed. Nothing will be imported.</p>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Filter chips */}
                      <div className={styles.reviewFilter} aria-label="Filter rows">
                        {(['all', 'new', 'updates', 'skips'] as ReviewFilter[]).map((f) => (
                          <button
                            key={f}
                            type="button"
                            className={`${styles.chip} ${reviewFilter === f ? styles.chipActive : ''}`}
                            onClick={() => setReviewFilter(f)}
                          >
                            {f === 'all' ? 'All' : f === 'new' ? 'New' : f === 'updates' ? 'Updates' : 'Skips'}
                          </button>
                        ))}
                        {hasIncomplete && (
                          <button
                            type="button"
                            className={`${styles.chip} ${reviewFilter === 'incomplete' ? styles.chipActive : ''}`}
                            onClick={() => setReviewFilter('incomplete')}
                          >
                            Incomplete
                          </button>
                        )}
                        {hasAmbiguous && (
                          <button
                            type="button"
                            className={`${styles.chip} ${reviewFilter === 'ambiguous' ? styles.chipActive : ''}`}
                            onClick={() => setReviewFilter('ambiguous')}
                          >
                            Ambiguous
                          </button>
                        )}
                      </div>

                      {/* Bulk actions */}
                      {selectedKeys.size > 0 && (
                        <div className={styles.bulkBar}>
                          <span>{selectedKeys.size} selected</span>
                          <button
                            type="button"
                            className={styles.btnSecondary}
                            onClick={bulkExcludeSelected}
                          >
                            Exclude selected
                          </button>
                        </div>
                      )}

                      {/* Lift catalog datalist for ambiguous rows: every built-in
                          canonical lift AND abbreviation/display-name alias
                          DEFAULT_SLOT_MAP accepts (ALL_SLOT_MAP_ALIASES — both
                          its keys and its values, so users are steered onto a
                          name the server actually recognizes, not just its
                          internal id), plus this user's custom lifts (#911).
                          Custom lifts whose name shadows a canonical alias are
                          excluded (the server now also refuses to create one
                          going forward, but a pre-existing one could still
                          exist) — offering it here would suggest a remap target
                          that silently resolves to the canonical built-in
                          instead, per buildEffectiveSlotMap's own precedence
                          rule (#911 review, second pass). */}
                      <datalist id="lift-catalog">
                        {ALL_SLOT_MAP_ALIASES.map((alias) => (
                          <option key={alias} value={alias} />
                        ))}
                        {customLifts
                          .filter((lift) => !defaultAliasesLower.has(lift.name.toLowerCase()))
                          .map((lift) => (
                            <option key={lift.id} value={lift.name} />
                          ))}
                      </datalist>

                      {/* Delta table */}
                      <table className={styles.deltaTable}>
                        <thead>
                          <tr>
                            <th aria-label="Select" />
                            <th>Row</th>
                            <th>Kind</th>
                            <th>Value</th>
                            <th aria-label="Exclude" />
                          </tr>
                        </thead>
                        <tbody>
                          {visibleDeltas.map((d) => {
                            const excluded = excludedKeys.has(d.key);
                            const selected = selectedKeys.has(d.key);
                            const isAmbiguous = d.status === 'ambiguous';

                            // #911: derive "no known match" reactively from the current
                            // typed/selected value (liftOverrides holds it once the user
                            // has interacted; otherwise it's still the original raw text).
                            const rowIndex = d.rowIndex;
                            // rawLiftValue (untrimmed) drives the controlled input's `value` —
                            // trimming it there would eat a just-typed trailing space on every
                            // keystroke, breaking multi-word names. currentLiftValue (trimmed)
                            // is for comparisons only (empty-check, knownLiftNames lookup).
                            const rawLiftValue =
                              (rowIndex !== undefined ? liftOverrides.get(rowIndex) : undefined) ??
                              d.originalLift ??
                              '';
                            const currentLiftValue = rawLiftValue.trim();
                            const draft = rowIndex !== undefined ? createDrafts.get(rowIndex) : undefined;
                            const showCreateNew =
                              isAmbiguous &&
                              !excluded &&
                              rowIndex !== undefined &&
                              // d.originalLift undefined means a blank/missing Lift
                              // cell — validateLiftImportSoft still flags it
                              // ambiguous, but there is no original text to create
                              // a lift FROM. Without this guard, typing any name
                              // enables an always-no-op Create button (#911 review,
                              // second pass) — see the click handler below, which
                              // also requires d.originalLift.
                              d.originalLift !== undefined &&
                              currentLiftValue !== '' &&
                              // Case-insensitive: see knownLiftNamesCanonical's doc
                              // comment for why exact-case-only checking let a case
                              // variant of a valid name create a shadowed duplicate.
                              !knownLiftNamesCanonical.has(currentLiftValue.toLowerCase());

                            return (
                              <tr
                                key={d.key}
                                className={[
                                  excluded ? styles.deltaExcluded : '',
                                  d.status === 'incomplete' ? styles.deltaIncomplete : '',
                                  isAmbiguous ? styles.deltaAmbiguous : '',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              >
                                <td>
                                  <input
                                    type="checkbox"
                                    className={styles.deltaCheckbox}
                                    checked={selected}
                                    readOnly
                                    onClick={(e) =>
                                      handleDeltaCheckbox(d.key, e.shiftKey, visibleDeltas)
                                    }
                                    aria-label={`Select ${d.label}`}
                                  />
                                </td>
                                <td className={styles.deltaLabel}>
                                  {isAmbiguous && !excluded ? (
                                    <>
                                      <input
                                        type="text"
                                        list="lift-catalog"
                                        className={styles.ambiguousInput}
                                        // Controlled (not defaultValue) so a programmatic
                                        // resolution — batch-resolve on create, or the 409
                                        // self-heal — is always visibly reflected, and can
                                        // never silently diverge from what's actually
                                        // submitted at commit (#911 review).
                                        value={rawLiftValue}
                                        placeholder="Type a lift name…"
                                        aria-label={`Lift name for row ${d.rowIndex}`}
                                        onChange={(e) => {
                                          if (d.rowIndex === undefined) return;
                                          const rIdx = d.rowIndex;
                                          const raw = e.target.value;
                                          // Always set — including '' — never delete.
                                          // This input is controlled off liftOverrides
                                          // (value={rawLiftValue}); deleting the map
                                          // entry on empty made rawLiftValue fall back
                                          // to d.originalLift, so the field snapped
                                          // back to the original CSV text on every
                                          // backspace-to-empty and could never actually
                                          // be cleared (#911 review, second pass).
                                          // handleCommit skips empty entries when
                                          // building the sent payload.
                                          setLiftOverrides((prev) => {
                                            const next = new Map(prev);
                                            next.set(rIdx, raw);
                                            return next;
                                          });
                                        }}
                                      />
                                      {showCreateNew && rowIndex !== undefined && (
                                        <div className={styles.createLiftAffordance}>
                                          <span className={styles.createLiftPrompt}>
                                            No match — create &quot;{currentLiftValue}&quot; as a
                                            new exercise
                                          </span>
                                          <div className={styles.chipRow}>
                                            {LIFT_CLASSIFICATIONS.map((c) => (
                                              <button
                                                key={c.value}
                                                type="button"
                                                className={`${styles.chip} ${draft?.classification === c.value ? styles.chipActive : ''}`}
                                                aria-pressed={draft?.classification === c.value}
                                                onClick={() => setDraftClassification(rowIndex, c.value)}
                                              >
                                                {c.label}
                                              </button>
                                            ))}
                                            <button
                                              type="button"
                                              className={styles.createLiftConfirm}
                                              disabled={!draft?.classification || draft?.busy}
                                              aria-label={`Create "${currentLiftValue}" as a new exercise`}
                                              onClick={() => {
                                                // d.originalLift is always populated for a
                                                // genuinely ambiguous delta (validateLiftImportSoft
                                                // only ever produces one alongside it) — guarded
                                                // explicitly rather than falling back to
                                                // currentLiftValue, which would silently match no
                                                // row at all (not even the triggering one) if this
                                                // were ever undefined (#911 review).
                                                if (!draft?.classification || d.originalLift === undefined) return;
                                                handleCreateLift(
                                                  currentLiftValue,
                                                  d.originalLift,
                                                  rowIndex,
                                                  draft.classification,
                                                );
                                              }}
                                            >
                                              {draft?.busy ? 'Creating…' : 'Create'}
                                            </button>
                                          </div>
                                          {draft?.error && (
                                            <span className={styles.createLiftError}>{draft.error}</span>
                                          )}
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    d.label
                                  )}
                                </td>
                                <td>
                                  <span
                                    className={`${styles.kindBadge} ${
                                      d.kind === 'create'
                                        ? styles.deltaKindCreate
                                        : d.kind === 'update'
                                          ? styles.deltaKindUpdate
                                          : styles.deltaKindSkip
                                    }`}
                                  >
                                    {d.status ?? d.kind}
                                  </span>
                                </td>
                                <td className={styles.deltaChange}>
                                  {d.kind === 'update'
                                    ? `${d.before} → ${d.after}`
                                    : d.kind === 'create'
                                      ? d.after
                                      : 'unchanged'}
                                </td>
                                <td>
                                  {!excluded ? (
                                    <button
                                      type="button"
                                      className={styles.maxEditRemove}
                                      aria-label={`Exclude ${d.label}`}
                                      onClick={() =>
                                        setExcludedKeys((prev) => new Set([...prev, d.key]))
                                      }
                                    >
                                      ×
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className={styles.undoExclude}
                                      aria-label={`Re-include ${d.label}`}
                                      onClick={() =>
                                        setExcludedKeys((prev) => {
                                          const next = new Set(prev);
                                          next.delete(d.key);
                                          return next;
                                        })
                                      }
                                    >
                                      ↩
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>

                      {visibleDeltas.length === 0 && (
                        <p className={styles.infoBox}>No rows match the current filter.</p>
                      )}
                    </>
                  )}
                </>
              ) : (
                <p className={styles.infoBox}>
                  {destination && `Destination: ${KIND_LABEL[destination]}. `}
                  No problems found — continue to preview the changes.
                </p>
              )}
            </>
          )}

          {/* ── PREVIEW ── */}
          {step === Step.PREVIEW && previewBody && (
            <>
              <h2 className={styles.stepTitle}>Preview changes</h2>
              <div className={styles.countRow}>
                <div className={styles.countPill}>
                  <span className={styles.countValue}>{previewBody.creates}</span>
                  <span className={styles.countLabel}>Create</span>
                </div>
                <div className={styles.countPill}>
                  <span className={styles.countValue}>{previewBody.updates}</span>
                  <span className={styles.countLabel}>Update</span>
                </div>
                <div className={styles.countPill}>
                  <span className={styles.countValue}>{previewBody.skips}</span>
                  <span className={styles.countLabel}>Skip</span>
                </div>
              </div>

              {preview?.split && (
                <div className={styles.splitCard}>
                  <p className={styles.stepHint}>
                    Also routing to {KIND_LABEL[preview.split.destination]}:
                  </p>
                  <div className={styles.countRow}>
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{preview.split.preview.creates}</span>
                      <span className={styles.countLabel}>Create</span>
                    </div>
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{preview.split.preview.updates}</span>
                      <span className={styles.countLabel}>Update</span>
                    </div>
                  </div>
                </div>
              )}

              {commitErrors && (
                <div className={styles.errorBox}>
                  <strong>Commit failed:</strong>
                  <ul className={styles.errorList}>
                    {commitErrors.slice(0, 20).map((e, i) => (
                      <li key={`${e.row}-${i}`}>
                        Row {e.row}: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {/* ── DONE ── */}
          {step === Step.DONE && commitResult && (
            <div className={styles.successBanner}>
              <p className={styles.successTitle}>Import complete</p>
              <p className={styles.successBody}>
                {KIND_LABEL[commitResult.destination]}: {commitResult.created} created,{' '}
                {commitResult.updated} updated, {commitResult.skipped} skipped.
              </p>

              {/* Per-row skip detail (lift-records only — see ImportCommitResponse.skippedDetail) */}
              {commitResult.skippedDetail && commitResult.skippedDetail.length > 0 && (
                <details className={styles.skippedDetailBox}>
                  <summary>Skipped rows</summary>
                  <ul className={styles.skippedDetailList}>
                    {commitResult.skippedDetail.map((s) => (
                      <li key={`${s.row}-${s.naturalKey}`}>
                        Row {s.row}: {s.naturalKey}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {/* Undo section */}
              {batchId !== null && undoResult === null && (
                <div className={styles.undoBanner}>
                  <button
                    type="button"
                    className={styles.undoBtn}
                    onClick={handleUndo}
                    disabled={busy}
                  >
                    {busy ? 'Undoing…' : 'Undo this import'}
                  </button>
                </div>
              )}

              {undoResult !== null && (
                <div className={styles.undoBanner}>
                  <p>
                    Undo complete: {undoResult.restored} restored
                    {undoResult.skipped > 0 ? `, ${undoResult.skipped} skipped` : ''}
                    {undoResult.flagged.length > 0
                      ? `, ${undoResult.flagged.length} flagged (modified since import)`
                      : ''}
                    .
                  </p>
                </div>
              )}

              {error && <p className={styles.errorNote}>{error}</p>}
            </div>
          )}
        </section>

        {/* ── ACTION ROW ── */}
        <div className={styles.actionRow}>
          {step >= 2 && step <= 5 && (
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={() => setStep((step === Step.CLASSIFY ? Step.SOURCE : step - 1) as typeof Step[keyof typeof Step])}
              disabled={busy}
            >
              Back
            </button>
          )}

          {step === Step.SOURCE && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={handleAnalyze}
              disabled={!programId || !file || busy}
            >
              Analyze
            </button>
          )}

          {step === Step.CLASSIFY && destination && (
            <button type="button" className={styles.btnPrimary} onClick={() => setStep(Step.MAP_COLUMNS)}>
              Next
            </button>
          )}

          {step === Step.MAP_COLUMNS && (
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={!allRequiredMapped}
              onClick={enterReview}
            >
              Next
            </button>
          )}

          {step === Step.REVIEW && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={() => setStep(Step.PREVIEW)}
              disabled={
                !previewBody ||
                (destination === 'training-maxes' &&
                  reviewMaxes !== null &&
                  reviewMaxes.filter((r) => !excludedKeys.has(r.lift)).length === 0)
              }
            >
              Next
            </button>
          )}

          {step === Step.PREVIEW && (
            <button
              type="button"
              className={styles.btnSuccess}
              onClick={handleCommit}
              disabled={busy || !previewBody}
            >
              {busy ? 'Importing…' : 'Commit import'}
            </button>
          )}

          {step === Step.DONE && (
            <button type="button" className={styles.btnPrimary} onClick={reset}>
              Import another file
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
