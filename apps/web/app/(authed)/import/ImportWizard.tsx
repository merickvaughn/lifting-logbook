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
import { ALL_SLOT_MAP_ALIASES, formatWeight, isCanonicalAlias } from '@lifting-logbook/core';
import {
  commitImport,
  createCustomLift,
  fetchCustomLifts,
  previewImport,
  undoImport,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { MAX_RENDERED_IMPORT_ERRORS, MAX_RENDERED_IMPORT_SKIPS } from '@/lib/import-constants';
import { Step, STEP_LABELS } from './steps';
import styles from './import.module.css';

type ReviewFilter = 'all' | 'new' | 'updates' | 'skips' | 'incomplete' | 'ambiguous';
type EditableMax = { lift: string; weight: string };

// Per-row transient state for the "create new exercise" affordance on an
// ambiguous row (issue #911) — keyed by rowIndex, mirroring liftOverrides.
// `name` is the exact text a busy (in-flight) draft is creating — set
// whenever `busy` becomes true, read by busyLiftNames below. It must be the
// name actually being submitted, not the row's original CSV text: two rows
// sharing original text can be retyped to different new names (this PR's own
// batch-resolve treats them as unrelated once retyped), and rows that share
// NO original text (e.g. two blank Lift cells, both originalLift === '')
// can still coincidentally be typed to the same new name — the in-flight
// guard exists to deduplicate the latter, not conflate the former (#911
// review, fourth pass — round 3 keyed this guard by originalLift instead,
// which over-blocked unrelated rows sharing blank/duplicate original text and
// under-blocked genuinely duplicate concurrent creates).
type CreateLiftDraft = {
  classification: LiftClassification | null;
  busy: boolean;
  error: string | null;
  name: string | null;
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

// Exhaustive BY CONSTRUCTION (issue #911 review) — LIFT_CLASSIFICATION_LABELS
// is typed Record<LiftClassification, string>, so the compiler itself rejects
// an incomplete map if LiftClassification ever gains a member. The earlier
// hand-written array version made the identical "exhaustive" claim in its own
// comment but was just a plain array literal — it type-checked fine with a
// member missing, silently leaving that value unreachable in the "create new
// exercise" affordance despite the comment (#911 review, third pass — this is
// the same overclaiming-comment pattern the second pass already corrected
// once in this same PR, in effective-slot-map.util.ts).
const LIFT_CLASSIFICATION_LABELS: Record<LiftClassification, string> = {
  compound: 'Compound',
  accessory: 'Accessory',
};
const LIFT_CLASSIFICATIONS: { value: LiftClassification; label: string }[] = (
  Object.entries(LIFT_CLASSIFICATION_LABELS) as [LiftClassification, string][]
).map(([value, label]) => ({ value, label }));

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

  // REVIEW filter chips — only show incomplete/ambiguous when rows exist.
  // Memoized (not two independent .some() scans on every render): the remap
  // <input> is controlled, so every keystroke re-renders this component, and
  // each scan walks up to MAX_IMPORT_ROWS deltas — cheap individually, but
  // wasted work on every keystroke across a large preview (#911 review,
  // eighth pass).
  const { hasIncomplete, hasAmbiguous } = useMemo(() => {
    const deltas = previewBody?.deltas ?? [];
    return {
      hasIncomplete: deltas.some((d) => d.status === 'incomplete'),
      hasAmbiguous: deltas.some((d) => d.status === 'ambiguous'),
    };
  }, [previewBody]);

  // Filtered deltas for the REVIEW table
  const visibleDeltas = useMemo(
    () => filterDeltas(previewBody?.deltas ?? [], reviewFilter),
    [previewBody, reviewFilter],
  );

  // Every string an ambiguous-row remap can resolve to via an EXACT-case
  // match: every canonical alias, plus this user's own custom lift names and
  // ids. buildEffectiveSlotMap only lets DEFAULT_SLOT_MAP win on an
  // exact-case collision — a custom lift named "squat" (lowercase) is a
  // genuinely distinct, reachable key from the canonical "Squat", not a
  // duplicate — so exact match must be checked, and must win, before ever
  // falling back to knownLiftNamesCanonical's case-insensitive lookup below
  // (#911 review, third pass — the second pass's case-insensitive-only
  // resolution would have silently rewritten a case-variant custom lift's own
  // name to the canonical built-in instead of honoring it, and hidden it from
  // the datalist entirely).
  const exactKnownLiftKeys = useMemo(() => {
    const set = new Set<string>(ALL_SLOT_MAP_ALIASES);
    for (const lift of customLifts) {
      set.add(lift.name);
      set.add(lift.id);
    }
    return set;
  }, [customLifts]);

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

  // The create-in-flight guard must be keyed by the NAME actually being
  // submitted to POST /lifts/custom, not by the row's original CSV text: N
  // ambiguous rows sharing the same originalLift each render their own
  // independently-"busy"-tracked Create button (createDrafts is keyed by
  // rowIndex), so without this a second click on a DIFFERENT row creating the
  // same name — before the first create resolves — fires a second POST for
  // it. The 409 self-heal refetch already covers the resulting race, but
  // preventing the redundant write is cheap and avoids two rows visibly stuck
  // on "Creating…" on a slow network.
  //
  // Deriving this from originalLift (an earlier version of this guard) was
  // wrong in both directions: two rows sharing original text can be retyped
  // to different new names (batch-resolve already treats them as unrelated
  // once retyped, so this guard shouldn't block them either), while two rows
  // with DIFFERENT original text — most commonly two separate blank Lift
  // cells, both originalLift === '' — can coincidentally be typed to the SAME
  // new name, which is exactly the duplicate-POST case this guard exists to
  // prevent and originalLift-keying couldn't see. Deriving from createDrafts'
  // own `name` field (set to the exact submitted value whenever `busy`
  // becomes true) keys this guard on the same thing it's guarding (#911
  // review, fourth pass).
  const busyLiftNames = useMemo(() => {
    const set = new Set<string>();
    for (const draft of createDrafts.values()) {
      if (draft.busy && draft.name) set.add(draft.name);
    }
    return set;
  }, [createDrafts]);

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
      // editable copy of the previous preview's deltas. columnOverrides is
      // keyed by sourceHeader/__req__:<field>, which collides across files
      // the same way delta.key does — a stale entry would silently drive
      // effectiveMappings and the commit `overrides` param off a column
      // mapping the user chose for a DIFFERENT file (#911 review: second pass
      // only cleared the first two of what is now seven; third pass added
      // this one, previously only cleared by handlePickDestination — a
      // narrower path than analyze() itself, this function's own comment's
      // stated canonical reset point).
      setLiftOverrides(new Map());
      setCreateDrafts(new Map());
      setExcludedKeys(new Set());
      setSelectedKeys(new Set());
      lastSelectedKey.current = null;
      setReviewMaxes(null);
      setColumnOverrides(new Map());
      // A commit failure from the PREVIOUS preview must not still be showing
      // once a new one replaces it — same "canonical reset point" rationale
      // as the rest of this block, just for the PREVIEW step's own error box
      // rather than a REVIEW-step field.
      setCommitErrors(null);
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
      const existing = next.get(rowIndex) ?? { classification: null, busy: false, error: null, name: null };
      next.set(rowIndex, {
        ...existing,
        classification: existing.classification === classification ? null : classification,
        error: null,
      });
      return next;
    });
  }

  // Clears any stale draft.error (without touching classification/busy) when
  // the user edits the remap input after a failed create — otherwise a
  // handleCreateLift failure message keeps rendering under a value that no
  // longer matches what the error was actually about (#911 review, third
  // pass).
  function clearCreateDraftError(rowIndex: number) {
    setCreateDrafts((prev) => {
      const existing = prev.get(rowIndex);
      if (!existing || existing.error === null) return prev;
      const next = new Map(prev);
      next.set(rowIndex, { ...existing, error: null });
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
      next.set(rowIndex, {
        classification: existing?.classification ?? null,
        busy: false,
        error,
        name: existing?.name ?? null,
      });
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
    // A blank/missing Lift cell also produces originalLift === '' (not just
    // "no original text at all" — see showCreateNew's own d.originalLift
    // !== undefined guard, which lets an empty string through). Matching on
    // '' would batch-resolve every OTHER blank-cell ambiguous row too — rows
    // that have nothing in common with the one the user actually typed a name
    // into, silently assigning them all to it. Blank cells are a realistic
    // shape for hand-maintained/Sheets-exported CSVs ("blank = same as row
    // above"), so this is not a hypothetical (#911 review, third pass).
    const isBatchable = matchOriginalLift.trim() !== '';
    setLiftOverrides((prev) => {
      const next = new Map(prev);
      for (const delta of deltas) {
        if (delta.rowIndex === undefined || delta.status !== 'ambiguous') continue;
        if (delta.rowIndex === triggeringRowIndex) {
          next.set(delta.rowIndex, liftId);
          continue;
        }
        if (!isBatchable) continue;
        // A row the user has explicitly excluded (× button) must not be
        // silently re-included by batch-resolve — excludedKeys is enforced
        // via UI/commit-payload filtering elsewhere, not by removing the row
        // from previewBody, so it still passes every other check here without
        // this guard (#911 review, third pass). This guard is necessary but
        // not sufficient on its own — an ambiguous row's exclusion doesn't
        // actually reach the server correctly at all (its __ambiguous_N key
        // can never match a natural key), a separate, pre-existing bug
        // tracked as issue #915.
        if (excludedKeys.has(delta.key)) continue;
        if (delta.originalLift !== matchOriginalLift) continue;
        const existing = next.get(delta.rowIndex);
        if (existing === undefined || existing === liftId) {
          next.set(delta.rowIndex, liftId);
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
      const existing = next.get(rowIndex) ?? { classification, busy: false, error: null, name: null };
      next.set(rowIndex, { ...existing, classification, busy: true, error: null, name });
      return next;
    });

    try {
      const created = await createCustomLift({ name, classification });
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
          // Ungated by previewGeneration — same rule as the successful-create
          // branch above: a freshly refetched list is authoritative server
          // truth, independent of whether this preview has since been
          // discarded. Gating it here (an earlier version of this fix) meant
          // this branch and the create-success branch enforced contradictory
          // rules for the identical class of data, one asserting the rule the
          // other violated — the discarded refetch cost the user the exact
          // extra POST + 409 + refetch round trip this self-heal exists to
          // avoid (#911 review, fifth pass).
          //
          // Merge rather than replace wholesale. `fetchedLifts` is
          // authoritative for every id it contains, but this refetch can be in
          // flight concurrently with a DIFFERENT ambiguous row's own
          // handleCreateLift call — two rows with different original text each
          // get their own independent create, so nothing here serializes them.
          // If that sibling row's create succeeds and appends to customLifts
          // (below) before this refetch resolves, `fetchedLifts` — a snapshot
          // the server returned for a request issued before that append —
          // won't contain it, and replacing wholesale would silently drop a
          // lift that was genuinely, successfully created just moments ago.
          // Keeping every `prev` entry `fetchedLifts` doesn't know about (by
          // id) preserves that sibling's lift without discarding anything
          // `fetchedLifts` itself added or already agreed on (issue #921).
          //
          // Captured into a `const` rather than reading the outer `let latest`
          // from inside the updater below: a `let`'s narrowing (non-null, just
          // assigned above) doesn't survive into a closure, so referencing
          // `latest` there would need a non-null assertion even though it
          // provably can't be null at this point in the try block.
          const fetchedLifts = latest;
          setCustomLifts((prev) => {
            const fetchedIds = new Set(fetchedLifts.map((l) => l.id));
            return [...fetchedLifts, ...prev.filter((p) => !fetchedIds.has(p.id))];
          });
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
        // setCustomLifts above is deliberately ungated (server truth), but
        // everything from here on is preview-keyed again — applyResolvedLiftToMatchingRows
        // reads previewBody.deltas from this closure's (potentially stale)
        // preview and writes into the CURRENT liftOverrides state, so it must
        // not run for a preview the user has since discarded (e.g. Back →
        // re-pick-destination while this refetch was in flight). This check
        // was previously combined with the (now-ungated) setCustomLifts call
        // above; removing that combined check for setCustomLifts's sake also
        // silently dropped protection for this branch (#911 review, sixth
        // pass).
        if (previewGeneration.current !== startGeneration) return;
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
        //
        // The non-refetch-failed message deliberately does NOT say "already
        // exists": createCustomLift's 409 collapses two distinct server-side
        // reasons (CustomLiftConflictError — a genuine duplicate name; and
        // ReservedLiftNameConflictError — the name collides with a canonical
        // built-in) into the same `null` return, and `existing` above only
        // ever finds the first kind (a reserved name is by definition never
        // in this user's own custom-lift list). Asserting "already exists"
        // unconditionally would misreport the second case outright. Not
        // reachable through this UI today — showCreateNew's own gate already
        // excludes any name the server would treat as reserved — but a wrong
        // claim here would still be wrong under client/API version skew or a
        // future non-wizard caller of handleCreateLift's request path (#911
        // review, eighth pass).
        setCreateDraftError(
          rowIndex,
          refetchFailed
            ? "Couldn't confirm whether this name already exists — try again."
            : "This name can't be used — it already exists or is reserved.",
        );
        return;
      }
      // Ungated by previewGeneration — reset()'s own comment states the rule
      // this follows: "any lift created this session is real, persisted
      // server-side data, not session-local UI state." A generation mismatch
      // here (the preview was discarded mid-request) must not cost the user
      // a lift they successfully created just because they hit Back in the
      // meantime — without this, the wizard would keep offering to "create"
      // an already-created lift, wasting a POST + 409 self-heal round trip on
      // the next attempt (#911 review, fourth pass).
      setCustomLifts((prev) => [...prev, created]);
      if (previewGeneration.current !== startGeneration) return; // preview discarded mid-request
      applyResolvedLiftToMatchingRows(matchOriginalLift, created.id, rowIndex);
      clearCreateDraft(rowIndex);
    } catch (e) {
      // Log unconditionally, before the generation check — same rule as the
      // fetchCustomLifts catch above: a genuine POST failure must always reach
      // Observability, even if the user has since navigated away from this
      // preview. Gating the log itself (an earlier version of this fix) meant
      // a real mutation error could be silently dropped with no beacon and no
      // console line, contradicting this project's own Observability
      // convention (CLAUDE.md, tracking #783) and this exact function's
      // sibling catch three branches up (#911 review, eighth pass). Never
      // include `name` — see the logClientError comment above.
      logClientError('createCustomLift', e, { programId, rowIndex });
      if (previewGeneration.current !== startGeneration) return; // preview discarded mid-request
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
        const ambiguousDeltas = (previewBody?.deltas ?? []).filter(
          (d) => d.status === 'ambiguous' && d.rowIndex !== undefined,
        );
        const currentAmbiguousRowIndexes = new Set(ambiguousDeltas.map((d) => d.rowIndex as number));
        // A row the user has explicitly excluded (× button) must not have an
        // override sent for it either — mirrors the same guard added to
        // applyResolvedLiftToMatchingRows (#911 review, third pass).
        const excludedRowIndexes = new Set(
          ambiguousDeltas.filter((d) => excludedKeys.has(d.key)).map((d) => d.rowIndex as number),
        );
        for (const [rowIdx, liftId] of liftOverrides.entries()) {
          if (!currentAmbiguousRowIndexes.has(rowIdx) || excludedRowIndexes.has(rowIdx)) continue;
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
          // Exact match first: a custom lift can legitimately be named a
          // case-variant of a canonical alias (e.g. "squat" alongside
          // "Squat") — buildEffectiveSlotMap only lets DEFAULT_SLOT_MAP win
          // on an *exact*-case collision, so "squat" is a distinct, genuinely
          // reachable server-side key, not a duplicate. Only when the typed
          // text matches nothing exactly does the case-insensitive canonical
          // fallback apply — for a user who typed "squat" meaning the
          // canonical "Squat", the server's slot-map lookup is exact-case, so
          // sending literally what they typed would fail the same
          // "not recognized" check the create-new gate just correctly steered
          // them around (#911 review, second and third passes — the second
          // pass's case-insensitive-only resolution here would have
          // mis-sent an exact-case-reachable custom lift's own name instead
          // of honoring it).
          if (exactKnownLiftKeys.has(trimmed)) {
            liftOverridesRecord[rowIdx] = trimmed;
          } else {
            const canonical = knownLiftNamesCanonical.get(trimmed.toLowerCase());
            liftOverridesRecord[rowIdx] = canonical ?? trimmed;
          }
        }
        result = await commitImport(programId, file, destination, {
          overrides: Object.keys(columnOverridesRecord).length > 0 ? columnOverridesRecord : undefined,
          excludeKeys: excludedKeys.size > 0 ? [...excludedKeys].map(stripDeltaKeySuffix) : undefined,
          liftOverrides:
            Object.keys(liftOverridesRecord).length > 0 ? liftOverridesRecord : undefined,
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
    // Bumped so an in-flight handleCreateLift from before this reset (only
    // reachable from the DONE step, so hard to hit, but not impossible — see
    // its own generation checks) can't repopulate liftOverrides/createDrafts
    // after this function just cleared them (#911 review, third pass).
    previewGeneration.current += 1;
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
                    {preview.errors.slice(0, MAX_RENDERED_IMPORT_ERRORS).map((e, i) => (
                      <li key={`${e.row}-${e.field}-${i}`}>
                        Row {e.row}
                        {e.field ? ` · ${e.field}` : ''}: {e.message}
                      </li>
                    ))}
                  </ul>
                  {/* The heading above already shows the true total, so this line is
                      belt-and-suspenders here — kept for consistency with the other two
                      capped lists in this file, all driven by the one shared constant. */}
                  {preview.errors.length > MAX_RENDERED_IMPORT_ERRORS && (
                    <p className={styles.errorOverflowNote}>
                      …and {preview.errors.length - MAX_RENDERED_IMPORT_ERRORS} more error(s) not
                      shown.
                    </p>
                  )}
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
                          Only an EXACT-case shadow is excluded — a
                          pre-existing custom lift whose name case-insensitively
                          but not exactly matches an alias (e.g. "squat" vs.
                          "Squat") is a distinct, genuinely reachable entry per
                          buildEffectiveSlotMap's exact-case-only collision
                          rule, and offering it is correct; only an exact-case
                          match is truly unreachable by that name (the server
                          also now refuses to create an exact-case-shadowing
                          custom lift going forward, but a pre-existing one
                          could still exist) (#911 review, third pass — an
                          earlier case-insensitive-only version of this filter
                          also hid every reachable case-variant custom lift). */}
                      <datalist id="lift-catalog">
                        {ALL_SLOT_MAP_ALIASES.map((alias) => (
                          <option key={alias} value={alias} />
                        ))}
                        {customLifts
                          .filter((lift) => !isCanonicalAlias(lift.name))
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
                              // ImportDelta.originalLift is typed string | undefined
                              // — validateLiftImportSoft itself never actually
                              // produces undefined (a blank cell OR a missing Lift
                              // column both normalize to '', per String(r.lift ??
                              // '').trim() — #911 review, fourth pass), but a
                              // future preview-building path could, and without
                              // this guard typing any name into such a row would
                              // enable an always-no-op Create button (the click
                              // handler below also requires d.originalLift, for the
                              // same type-safety reason) (#911 review, second pass).
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
                                        // Disabled while this row's own create is in flight —
                                        // without this, a mid-flight retype is silently
                                        // overwritten on resolve (applyResolvedLiftToMatchingRows
                                        // sets the triggering row unconditionally), discarding
                                        // whatever the user just typed with no signal (#911
                                        // review, sixth pass).
                                        disabled={draft?.busy ?? false}
                                        // Controlled (not defaultValue) so a programmatic
                                        // resolution — batch-resolve on create, or the 409
                                        // self-heal — is always visibly reflected, and can
                                        // never silently diverge from what's actually
                                        // submitted at commit. Trade-off: every keystroke here
                                        // now re-renders the full delta table (up to 5,000
                                        // rows) — tracked as issue #916, not fixed here since
                                        // this correctness fix must not be reverted to get it
                                        // back.
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
                                          // A prior failed-create error (e.g. "already
                                          // exists") is about the OLD value, not
                                          // whatever the user is now typing — stale
                                          // otherwise (#911 review, third pass).
                                          clearCreateDraftError(rIdx);
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
                                                // Disabled while busy for the same reason the
                                                // remap input is: a mid-flight change here
                                                // would show a classification the in-flight
                                                // POST doesn't actually carry.
                                                disabled={draft?.busy ?? false}
                                                onClick={() => setDraftClassification(rowIndex, c.value)}
                                              >
                                                {c.label}
                                              </button>
                                            ))}
                                            <button
                                              type="button"
                                              className={styles.createLiftConfirm}
                                              disabled={
                                                !draft?.classification ||
                                                // draft?.busy: this row's own in-flight create.
                                                // busyLiftNames: a DIFFERENT row currently
                                                // creating the same submitted name. The remap
                                                // input and classification chips above are also
                                                // disabled while busy, so draft?.busy is
                                                // defense-in-depth here rather than the only
                                                // thing preventing a mid-flight retype — but this
                                                // check doesn't depend on that staying true.
                                                draft?.busy ||
                                                busyLiftNames.has(currentLiftValue)
                                              }
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
                    {commitErrors.slice(0, MAX_RENDERED_IMPORT_ERRORS).map((e, i) => (
                      <li key={`${e.row}-${i}`}>
                        Row {e.row}: {e.message}
                      </li>
                    ))}
                  </ul>
                  {commitErrors.length > MAX_RENDERED_IMPORT_ERRORS && (
                    <p className={styles.errorOverflowNote}>
                      …and {commitErrors.length - MAX_RENDERED_IMPORT_ERRORS} more error(s) not
                      shown.
                    </p>
                  )}
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

              {/* Per-row skip detail (lift-records only — see ImportCommitResponse.skippedDetail).
                  Capped like the error lists above — up to MAX_IMPORT_ROWS rows can be reported
                  as skipped, and <details> only hides this via UA styling, not by deferring React
                  from creating every <li> on render (#911 review, ninth pass). */}
              {commitResult.skippedDetail && commitResult.skippedDetail.length > 0 && (
                <details className={styles.skippedDetailBox}>
                  <summary>Skipped rows</summary>
                  <ul className={styles.skippedDetailList}>
                    {commitResult.skippedDetail.slice(0, MAX_RENDERED_IMPORT_SKIPS).map((s) => (
                      <li key={`${s.row}-${s.naturalKey}`}>
                        Row {s.row}: {s.naturalKey}
                      </li>
                    ))}
                  </ul>
                  {commitResult.skippedDetail.length > MAX_RENDERED_IMPORT_SKIPS && (
                    <p className={styles.skippedOverflowNote}>
                      …and {commitResult.skippedDetail.length - MAX_RENDERED_IMPORT_SKIPS} more
                      skipped row(s) not shown.
                    </p>
                  )}
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
              onClick={() => {
                // Clears a stale "Commit failed:" list from a previous attempt at this
                // exact step transition — the one seam every path into PREVIEW passes
                // through (PREVIEW is only ever reached via this button; enterReview()
                // above is NOT on the Back-from-PREVIEW-then-Next path, since the Back
                // button decrements `step` directly without calling it). Without this,
                // a failed commit → Back → fix the named rows → Next re-shows the exact
                // same error list, unchanged, before the next real Commit click clears
                // it — the same "stale message under a value the user already fixed"
                // class this PR has already closed twice elsewhere (round 3's
                // clearCreateDraftError, round 7's commitErrors-in-analyze() reset;
                // #911 review, tenth pass).
                setCommitErrors(null);
                setStep(Step.PREVIEW);
              }}
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
