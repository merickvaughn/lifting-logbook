'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  ColumnMapping,
  CustomLiftResponse,
  GoogleSheetTab,
  ImportCommitResponse,
  ImportDelta,
  ImportDryRunResponse,
  ImportError,
  ImportKind,
  ImportPreviewResponse,
  ImportGoalSpellingCollision,
  ImportSpellingCollision,
  ImportUndoResponse,
  LiftClassification,
  WeightUnit,
} from '@lifting-logbook/types';
import {
  ALL_SLOT_MAP_ALIASES,
  IMPORT_LIFT_ALIASES,
  LIFT_CATALOG,
  formatWeight,
} from '@lifting-logbook/core';
import type { CommitImportOpts } from '@lifting-logbook/api-client';
import {
  commitImport,
  createCustomLift,
  dryRunImport,
  fetchCustomLifts,
  fetchGoogleSheetWorkbook,
  previewImport,
  undoImport,
} from '@/lib/client-api';
import { localToday } from '@/lib/calendarDay';
import { logClientError } from '@/lib/log-client-error';
import { MAX_RENDERED_IMPORT_ERRORS, MAX_RENDERED_IMPORT_SKIPS } from '@/lib/import-constants';
import { LIFT_CLASSIFICATIONS } from './liftClassifications';
import { KIND_LABEL, kindsForTarget, Step, STEP_LABELS } from './steps';
import type { ImportTarget } from './steps';
import {
  SheetTabsStep,
  defaultTabChoices,
  previewKey,
  tabFile,
  type SheetTabChoices,
  type TabPreviews,
} from './SheetTabsStep';
import ImportMissingMaxes from './ImportMissingMaxes';
import SpellingCollisionNotice from './SpellingCollisionNotice';
import styles from './import.module.css';

type ReviewFilter = 'all' | 'new' | 'updates' | 'skips' | 'incomplete' | 'ambiguous' | 'needs-lift';
type EditableMax = { lift: string; label: string; weight: string };
type QueuedTab = { name: string; csv: string; kind: ImportKind };
type CompletedTab = {
  name: string;
  /** The workbook fetch the tab came from, the kind it was queued as, and the program it was committed to. */
  workbookId: number;
  kind: ImportKind;
  programId: string;
  result: ImportCommitResponse;
  batchId: string | null;
  undo: ImportUndoResponse | null;
};

// Per-row transient state for the "create new lift" affordance on an
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

// What the wizard will send to commit, with the counts the server gave for it. The
// Preview step shows these counts and Commit sends this exact request, so the two
// can't drift apart.
type PlannedCommit = { file: File; opts?: CommitImportOpts; counts: ImportDryRunResponse };

// ImportDelta.key can repeat a natural key with a `#N` suffix, which identifies a row
// only in this component.
function naturalKeyOf(delta: ImportDelta): string {
  return delta.key.replace(/#\d+$/, '');
}

// The server's position key leaves a same-keyed row alone (#1123). An API rolled back to
// before that has no rowIndex and matches the bare natural key.
function excludeKeyFor(delta: ImportDelta): string {
  return delta.rowIndex !== undefined ? `__row_${delta.rowIndex}` : naturalKeyOf(delta);
}

function buildTrainingMaxesCsv(rows: Pick<EditableMax, 'lift' | 'weight'>[]): string {
  const today = localToday();
  const lines = rows
    .filter((r) => Number(r.weight) > 0)
    .map((r) => `${today},"${r.lift.replace(/"/g, '""')}",${Number(r.weight)}`);
  return ['Date Updated,Lift,Weight', ...lines].join('\n');
}

type FieldOption = { key: string; label: string };

const KIND_FIELDS: Record<ImportKind, FieldOption[]> = {
  'lift-records': [
    { key: 'program', label: 'Program' },
    { key: 'macrocycleNum', label: 'Macrocycle #' },
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

function bucketClass(bucket: 'high' | 'medium' | 'low'): string {
  return bucket === 'high'
    ? styles.bucketHigh ?? ''
    : bucket === 'medium'
      ? styles.bucketMedium ?? ''
      : styles.bucketLow ?? '';
}

// Sorted, because undoing and redoing a remap changes its insertion order but not its meaning.
function columnOverridesKey(overrides: Record<string, string>): string {
  return JSON.stringify(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
}

const NO_COLUMN_OVERRIDES = columnOverridesKey({});

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
  programsLoadFailed = false,
  customLifts: initialCustomLifts,
  unit = 'lbs',
}: {
  /** Where this user can import to. The first is preselected. */
  programs: ImportTarget[];
  /** A fetch behind `programs` failed, so it may be missing some, including the active one. */
  programsLoadFailed?: boolean;
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
  // Rows of a spelling collision the user kept as custom lifts, as `key|spelling` (#1135).
  const [keptSpellings, setKeptSpellings] = useState<ReadonlySet<string>>(new Set());
  const [plannedCommit, setPlannedCommit] = useState<PlannedCommit | null>(null);
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [liftOverrides, setLiftOverrides] = useState<Map<number, string>>(new Map());
  // Seeded from the server-fetched prop, then grown locally as the user creates
  // exercises inline during this session (#911) — no page reload needed to see
  // a just-created lift reflected in the remap datalist.
  const [customLifts, setCustomLifts] = useState<CustomLiftResponse[]>(initialCustomLifts);
  // Every lift id created via THIS wizard session's success branch below — not
  // the initial server-fetched customLifts prop, and not anything a refetch
  // has ever returned. Scopes the 409 branch's merge (#921): when that merge
  // keeps a `prev` entry a refetch doesn't know about, it must be because the
  // entry is a sibling row's just-created lift racing the refetch, not because
  // the entry was deleted server-side (e.g. via Settings, in another tab)
  // between when it entered customLifts and when this refetch ran — nothing
  // else in this component ever removes a customLifts entry, so without this
  // scope the merge would resurrect a genuinely-deleted lift right alongside
  // fixing the race it's meant to fix (#921 review).
  const sessionCreatedLiftIds = useRef<Set<string>>(new Set());
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
  // The column remaps the current preview was taken with.
  const previewedColumnOverrides = useRef(NO_COLUMN_OVERRIDES);
  const [needsLiftSnapshot, setNeedsLiftSnapshot] = useState<ReadonlySet<string>>(new Set());
  const [reviewEditsDiscarded, setReviewEditsDiscarded] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [undoResult, setUndoResult] = useState<ImportUndoResponse | null>(null);

  // Column mapping overrides from MAP_COLUMNS step
  const [columnOverrides, setColumnOverrides] = useState<Map<string, string>>(new Map());

  // Google Sheets source (#1111): the fetched workbook's tabs, which ones to
  // import as what, and the queue of chosen tabs stepped through one at a time.
  const [sourceMode, setSourceMode] = useState<'file' | 'sheet'>('file');
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetTabs, setSheetTabs] = useState<GoogleSheetTab[] | null>(null);
  const [tabChoices, setTabChoices] = useState<SheetTabChoices>({});
  const [tabQueue, setTabQueue] = useState<QueuedTab[]>([]);
  const [tabIndex, setTabIndex] = useState(0);
  const [completedTabs, setCompletedTabs] = useState<CompletedTab[]>([]);
  const [tabPreviews, setTabPreviews] = useState<TabPreviews>({});
  // Bumped on every workbook fetch. Preview keys and completed tabs carry it, so a
  // late response or a same-named tab from an earlier workbook can't be mistaken
  // for the current one.
  const [workbookId, setWorkbookId] = useState(0);
  // Only a Sheets run in progress has a current or next tab; a CSV upload never does.
  const sheetRun = sourceMode === 'sheet' && step !== Step.SOURCE;
  const currentTab = sheetRun ? tabQueue[tabIndex] : undefined;
  const nextTab = sheetRun ? tabQueue[tabIndex + 1] : undefined;

  const destination = preview?.destination ?? null;
  const selectedProgram = programs.find((p) => p.id === programId);
  const availableKinds = kindsForTarget(selectedProgram);
  const destinationUnavailable = destination !== null && !availableKinds.includes(destination);

  // A template can't take a program file, so moving to one unchecks any tab chosen as one.
  function selectProgram(id: string) {
    const kinds = kindsForTarget(programs.find((p) => p.id === id));
    setProgramId(id);
    setTabChoices((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([, kind]) => kinds.includes(kind))),
    );
  }
  const previewBody = preview?.preview ?? null;
  // Goal rows spelling one lift differently, by row position (#1169).
  const goalRowSpellings = useMemo(
    () =>
      new Map(
        (previewBody?.goalSpellingCollisions ?? []).flatMap((collision) =>
          collision.rows.flatMap((row) => row.rowIndexes.map((i) => [i, row.spelling] as const)),
        ),
      ),
    [previewBody],
  );

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

  // Filtered deltas for the REVIEW table. 'needs-lift' lists the rows that needed
  // a lift when the user asked to see them. It's a snapshot so a row doesn't vanish
  // mid-typing the moment its text first matches a known lift ("Squat" on the way
  // to "Squat (paused)").
  const visibleDeltas = useMemo(() => {
    const deltas = previewBody?.deltas ?? [];
    if (reviewFilter === 'needs-lift') return deltas.filter((d) => needsLiftSnapshot.has(d.key));
    return filterDeltas(deltas, reviewFilter);
  }, [previewBody, reviewFilter, needsLiftSnapshot]);

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
    const set = new Set<string>(IMPORT_LIFT_ALIASES);
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
    for (const alias of IMPORT_LIFT_ALIASES) {
      map.set(alias.toLowerCase(), alias);
    }
    for (const lift of customLifts) {
      const nameKey = lift.name.toLowerCase();
      if (!map.has(nameKey)) map.set(nameKey, lift.name);
      map.set(lift.id.toLowerCase(), lift.id);
    }
    return map;
  }, [customLifts]);

  // A remap stores a custom lift's id once it's created. Show its name instead.
  const customLiftNames = useMemo(
    () => new Map(customLifts.map((lift) => [lift.id, lift.name])),
    [customLifts],
  );

  // Names that fit more than one lift once case is ignored: a custom lift sharing
  // its lowercased name with a built-in alias or another custom lift. Text in a
  // different case can't choose between them, so the user has to.
  const caseTiedLiftNames = useMemo(() => {
    const aliases = new Set(IMPORT_LIFT_ALIASES.map((alias) => alias.toLowerCase()));
    const seen = new Set<string>();
    const tied = new Set<string>();
    for (const lift of customLifts) {
      const lower = lift.name.toLowerCase();
      if (aliases.has(lower) || seen.has(lower)) tied.add(lower);
      seen.add(lower);
    }
    return tied;
  }, [customLifts]);

  // The value a commit must send for a row's lift text, or undefined if the
  // server wouldn't recognize it. An exact match wins, because the server's slot-map
  // lookup is exact-case: a custom lift named "squat" is a distinct, reachable
  // key from the canonical "Squat", so it must be honored as typed (#911
  // review, third pass). Only text that matches nothing exactly falls back to
  // the case-insensitive canonical form. A lift named only in a remap input
  // can't be committed until it's created.
  const resolveLiftValue = useCallback(
    (raw: string): string | undefined => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      if (exactKnownLiftKeys.has(trimmed)) return trimmed;
      const lower = trimmed.toLowerCase();
      if (caseTiedLiftNames.has(lower)) return undefined;
      return knownLiftNamesCanonical.get(lower);
    },
    [exactKnownLiftKeys, knownLiftNamesCanonical, caseTiedLiftNames],
  );

  // A row's current lift text: its override, or the file's text if it has none.
  // `??` matters: a cleared input ('') must not fall back to the file's text.
  const rowLiftText = useCallback(
    (d: ImportDelta) =>
      (d.rowIndex !== undefined ? liftOverrides.get(d.rowIndex) : undefined) ?? d.originalLift ?? '',
    [liftOverrides],
  );

  // Rows the commit would reject until they're fixed or excluded (#1114). d.status
  // never changes once a row is flagged, so whether an ambiguous row is fixed has to
  // be worked out from its current text.
  const reviewCounts = useMemo(() => {
    const counts = { needsLiftKeys: new Set<string>(), incomplete: 0 };
    for (const d of previewBody?.deltas ?? []) {
      if (excludedKeys.has(d.key)) continue;
      if (d.status === 'incomplete') {
        counts.incomplete += 1;
      } else if (d.status === 'ambiguous' && !(d.rowIndex !== undefined && resolveLiftValue(rowLiftText(d)))) {
        counts.needsLiftKeys.add(d.key);
      }
    }
    return counts;
  }, [previewBody, excludedKeys, rowLiftText, resolveLiftValue]);
  const needsLiftCount = reviewCounts.needsLiftKeys.size;
  const unresolvedCount = needsLiftCount + reviewCounts.incomplete;

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

  // Every piece of state keyed to the previous preview's deltas/rows must be
  // cleared when a new preview replaces them — reachable via the Back →
  // re-pick-destination path (handlePickDestination) and a column remap
  // (enterReview). liftOverrides and createDrafts are keyed by rowIndex; a stale
  // entry surviving would drive a render-time decision on an unrelated row of the
  // new preview (suppressing or fabricating its create-new affordance) and still
  // be sent as its commit override. excludedKeys/selectedKeys are keyed by
  // delta.key, which can collide across previews too (e.g. ambiguous rows always
  // key as `__ambiguous_<rowIndex>`, so file A's row 1 and file B's row 1 collide)
  // — an uncleared exclude would then silently drop an unrelated row from the new
  // file's import with nothing in the UI explaining why. reviewMaxes is the
  // training-maxes REVIEW step's own editable copy of the previous preview's
  // deltas. A commit failure from the PREVIOUS preview must not still be showing
  // either.
  function clearPreviewRowState() {
    previewGeneration.current += 1;
    setLiftOverrides(new Map());
    setCreateDrafts(new Map());
    setExcludedKeys(new Set());
    setSelectedKeys(new Set());
    lastSelectedKey.current = null;
    setReviewMaxes(null);
    setKeptSpellings(new Set());
    setPlannedCommit(null);
    setCommitErrors(null);
  }

  // `source` defaults to the file in state; a Google Sheets tab passes its file
  // directly because the setFile() that queued it hasn't re-rendered yet, plus
  // the overview's preview of it when one is ready, so it isn't uploaded again.
  async function analyze(
    override?: ImportKind,
    source: File | null = file,
    cached?: ImportPreviewResponse,
  ): Promise<ImportPreviewResponse | null> {
    if (!programId || !source) return null;
    setError(null);
    setBusy(true);
    try {
      const res = cached ?? (await previewImport(programId, source, override));
      setPreview(res);
      clearPreviewRowState();
      // columnOverrides is keyed by sourceHeader/__req__:<field>, which collides
      // across files the same way delta.key does — a stale entry would silently
      // drive effectiveMappings and the commit `overrides` param off a column
      // mapping the user chose for a DIFFERENT file (#911 review, third pass:
      // previously only cleared by handlePickDestination, a narrower path than
      // analyze() itself).
      setColumnOverrides(new Map());
      previewedColumnOverrides.current = NO_COLUMN_OVERRIDES;
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

  async function handleFetchSheet() {
    if (!programId || !sheetUrl.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const { tabs } = await fetchGoogleSheetWorkbook(programId, sheetUrl.trim());
      setSheetTabs(tabs);
      setTabChoices(defaultTabChoices(tabs));
      // A new workbook starts a new run. Completed tabs are kept so their Undo stays available.
      setWorkbookId((id) => id + 1);
      setTabPreviews({});
      setTabQueue([]);
      setTabIndex(0);
    } catch (e) {
      logClientError('fetchGoogleSheetWorkbook', e, { programId });
      setError(e instanceof Error ? e.message : 'Could not fetch the Google Sheet');
    } finally {
      setBusy(false);
    }
  }

  // Runs one queued Google Sheets tab through the regular per-file flow,
  // skipping CLASSIFY since the destination was already chosen per tab. A
  // failure returns to SOURCE with the queue and completed tabs kept, so
  // "Import N tabs" resumes with only the tabs not yet committed.
  async function startTab(queue: QueuedTab[], index: number) {
    const tab = queue[index];
    if (!tab) return;
    const tabAsFile = tabFile(tab);
    // tabPreviews is emptied by every commit, so a preview found here predates no commit.
    const overview = tabPreviews[previewKey(workbookId, programId, tab.name, tab.kind)];
    setTabIndex(index);
    setFile(tabAsFile);
    setStep(Step.ANALYZING);
    const res = await analyze(tab.kind, tabAsFile, overview?.status === 'ready' ? overview.res : undefined);
    setStep(res ? Step.MAP_COLUMNS : Step.SOURCE);
  }

  // Committed, and not since undone, for this workbook fetch, kind and program.
  function isCompleted(tab: Pick<QueuedTab, 'name' | 'kind'>): boolean {
    return completedTabs.some(
      (t) =>
        t.workbookId === workbookId && t.name === tab.name && t.kind === tab.kind && t.programId === programId && !t.undo,
    );
  }

  // Tabs checked in the overview that this run has not committed yet.
  const pendingSheetTabs: QueuedTab[] = (sheetTabs ?? []).flatMap((t) => {
    const kind = tabChoices[t.name];
    return kind && t.csv !== null && !isCompleted({ name: t.name, kind }) ? [{ name: t.name, csv: t.csv, kind }] : [];
  });

  async function handleStartSheetImport() {
    // Import in the workbook's tab order, as listed in the overview table.
    setTabQueue(pendingSheetTabs);
    await startTab(pendingSheetTabs, 0);
  }

  async function handleNextTab() {
    const current = tabQueue[tabIndex];
    if (current && commitResult) {
      setCompletedTabs((prev) => [
        ...prev,
        { name: current.name, workbookId, kind: current.kind, programId, result: commitResult, batchId, undo: undoResult },
      ]);
    }
    resetFileState();
    await startTab(tabQueue, tabIndex + 1);
  }

  async function handleUndoCompletedTab(entry: CompletedTab) {
    if (!entry.batchId || entry.undo) return;
    setBusy(true);
    try {
      // The program the tab was committed to, which the selector may no longer show.
      const undo = await undoImport(entry.programId, entry.batchId);
      setCompletedTabs((prev) => prev.map((t) => (t === entry ? { ...t, undo } : t)));
    } catch (e) {
      logClientError('undoImport', e, { programId: entry.programId, batchId: entry.batchId });
      setError(e instanceof Error ? e.message : 'Undo failed');
    } finally {
      setBusy(false);
    }
  }

  async function enterReview() {
    let rows = previewBody;
    let rowsReplaced = false;
    let editsDiscarded = false;
    // The file was previewed before this step, so a column remapped here isn't in
    // that preview. The commit does apply it, so Review's rows and the commit gate
    // would disagree with the commit: a remapped Lift column would block every row
    // as needing a lift (#1114). Unchanged remaps keep the user's Review work.
    const overridesKey = columnOverridesKey(columnOverridesRecord);
    if (programId && file && destination && overridesKey !== previewedColumnOverrides.current) {
      setError(null);
      setBusy(true);
      try {
        const res = await previewImport(programId, file, destination, { overrides: columnOverridesRecord });
        // Keeps what this step is showing: `columnOverrides` is keyed to the file's
        // own headers, and the commit applies it to the original file.
        setPreview((prev) => prev && { ...res, classification: prev.classification, columnMappings: prev.columnMappings });
        // A new preview means new rows, so Review's edits can't carry over. Say so:
        // an exclusion that silently vanished would write a row the user removed.
        editsDiscarded = excludedKeys.size > 0 || liftOverrides.size > 0 || reviewMaxes !== null;
        clearPreviewRowState();
        previewedColumnOverrides.current = overridesKey;
        rows = res.preview;
        rowsReplaced = true;
      } catch (e) {
        logClientError('previewImport', e, { programId });
        setError(e instanceof Error ? e.message : 'Preview failed');
        return;
      } finally {
        setBusy(false);
      }
    }
    // Initialize TM editable list from preview deltas (create + update rows)
    if (destination === 'training-maxes' && rows && (reviewMaxes === null || rowsReplaced)) {
      // The API names a lift once, so rows stored separately for one lift would read the same
      // (`Squat` stores as back-squat, whose name is Back Squat). The list names them as the
      // file did. Rows are most recent first, so a stored lift takes its newest row's spelling.
      const spellingOf = new Map(
        (rows.spellingCollisions ?? []).flatMap((collision) =>
          new Set(collision.rows.map((row) => row.lift)).size > 1
            ? [...collision.rows].reverse().map((row) => [row.lift, row.spelling] as const)
            : [],
        ),
      );
      setReviewMaxes(
        rows.deltas
          .filter((d) => d.kind === 'create' || d.kind === 'update')
          // A create or update row's key is the stored lift, with no duplicate suffix.
          .map((d) => ({ lift: d.key, label: spellingOf.get(d.key) ?? d.label, weight: d.after ?? '' })),
      );
    }
    setReviewEditsDiscarded(editsDiscarded);
    setReviewFilter('all');
    setSelectedKeys(new Set());
    lastSelectedKey.current = null;
    setStep(Step.REVIEW);
  }

  function remainingCollisionRows(collision: ImportSpellingCollision, kept: ReadonlySet<string>) {
    return collision.rows.filter((row) => !kept.has(`${collision.key}|${row.spelling}`));
  }

  // The kept row goes on the list under its new lift, and leaves the stored lift it was
  // writing to, keeping any edit made to its weight. A row that shared that lift, and was
  // older, takes over from it, so every row's max is stored (#1135).
  function applyKeptRow(
    collision: ImportSpellingCollision,
    row: ImportSpellingCollision['rows'][number],
    lift: CustomLiftResponse,
  ) {
    const sharing = (rows: ImportSpellingCollision['rows']) => rows.filter((r) => r.lift === row.lift);
    const kept = new Set(keptSpellings).add(`${collision.key}|${row.spelling}`);
    const wasStored = sharing(remainingCollisionRows(collision, keptSpellings))[0]?.spelling === row.spelling;
    const [next] = sharing(remainingCollisionRows(collision, kept));
    setKeptSpellings(kept);
    setReviewMaxes((prev) => {
      if (!prev) return prev;
      const current = prev.find((r) => r.lift === row.lift);
      return [
        ...(wasStored ? prev.filter((r) => r.lift !== row.lift) : prev),
        ...(wasStored && next
          ? [{ lift: row.lift, label: current?.label ?? collision.label, weight: String(next.weight) }]
          : []),
        { lift: lift.id, label: lift.name, weight: wasStored && current ? current.weight : String(row.weight) },
      ];
    });
  }

  // A collision's spellings as excluding rows leaves them. An excluded row isn't written, so a
  // spelling shows its first row still included, and the first of those is the one stored.
  function writtenGoalRows(collision: ImportGoalSpellingCollision) {
    const included = new Map(
      (previewBody?.deltas ?? []).filter((d) => !excludedKeys.has(d.key)).map((d) => [d.rowIndex, d] as const),
    );
    return collision.rows
      .flatMap((row) => {
        const rowIndex = row.rowIndexes.find((i) => included.has(i));
        if (rowIndex === undefined) return [];
        return [{ row: { ...row, value: included.get(rowIndex)?.after ?? row.value }, rowIndex }];
      })
      .sort((a, b) => a.rowIndex - b.rowIndex)
      .map(({ row }) => row);
  }

  // A goal file has no editable list to move the row on, so the kept rows go in as overrides and
  // the server previews the result: the rows' labels and kinds, and any collision left (#1169).
  // That renumbers the `#N` keys, so exclusions follow their rows across. Returns the error to
  // show, if any.
  async function keepGoalRow(
    row: ImportGoalSpellingCollision['rows'][number],
    lift: CustomLiftResponse,
  ): Promise<string | null> {
    if (!programId || !file) return 'Could not update the preview. Try again.';
    const overrides = new Map(liftOverrides);
    for (const rowIndex of row.rowIndexes) overrides.set(rowIndex, lift.id);
    try {
      const res = await previewImport(programId, file, 'strength-goals', {
        overrides: columnOverridesRecord,
        liftOverrides: Object.fromEntries(overrides),
      });
      const deltas = res.preview?.deltas;
      if (!deltas) throw new Error(res.errors[0]?.message ?? 'Preview returned no rows');
      // A successful create can name a lift another row already spells, which merges them
      // and would lose that row's goal.
      if (deltas.filter((d) => naturalKeyOf(d) === lift.id).length > row.rowIndexes.length) {
        return `${lift.name} already has a goal in this import. Try another name.`;
      }
      const excludedRows = new Set(
        previewBody?.deltas.filter((d) => excludedKeys.has(d.key)).map((d) => d.rowIndex),
      );
      setLiftOverrides(overrides);
      setPreview((prev) => prev && { ...res, classification: prev.classification, columnMappings: prev.columnMappings });
      setExcludedKeys(new Set(deltas.filter((d) => excludedRows.has(d.rowIndex)).map((d) => d.key)));
      setSelectedKeys(new Set());
      lastSelectedKey.current = null;
      return null;
    } catch (e) {
      logClientError('previewImport', e, { programId, source: 'spelling-collision' });
      return 'Could not update the preview. Try again.';
    }
  }

  // Holds `busy` for the whole request. That blocks Back, Next and the other Keep buttons, so
  // what this applies can't land on a replaced preview, be left out of the commit Next would
  // freeze, or race another Keep. Returns the error to show, if any.
  async function handleKeepAsCustom(
    noun: 'max' | 'goal',
    name: string,
    classification: LiftClassification,
    apply: (lift: CustomLiftResponse) => string | null | Promise<string | null>,
  ): Promise<string | null> {
    setBusy(true);
    try {
      const result = await createCustomLift({ name, classification });
      if (result.ok) {
        sessionCreatedLiftIds.current.add(result.data.id);
        setCustomLifts((prev) => [...prev, result.data]);
        return await apply(result.data);
      }
      // An earlier import left this lift behind, as a Keep creates it before the commit.
      let existing: CustomLiftResponse | undefined;
      try {
        existing = (await refetchCustomLifts()).find((lift) => lift.name === name);
      } catch (e) {
        logClientError('fetchCustomLifts', e, { programId, source: 'spelling-collision' });
      }
      if (!existing) return result.conflictMessage;
      const reusedId = existing.id;
      // Reusing it here would replace, or repeat, the max this import already has for it.
      if (
        reviewMaxes?.some((max) => max.lift === reusedId) ||
        previewBody?.deltas.some((d) => naturalKeyOf(d) === reusedId)
      ) {
        return `${name} already has a ${noun} in this import. Try another name.`;
      }
      return await apply(existing);
    } catch (e) {
      // No lift name in the context: it is free text from the user's file.
      logClientError('createCustomLift', e, { programId, source: 'spelling-collision' });
      return 'Could not create the lift. Try again.';
    } finally {
      setBusy(false);
    }
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

  // Toggles the classification chip for an in-progress "create new lift" draft
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

  // Clears a stale creation error (without touching classification/busy) when
  // the user edits the remap input after a failed create — otherwise the
  // prior attempt's conflict message (e.g. "A custom lift named '…' already
  // exists") keeps rendering under a value that no longer matches the name
  // that error was actually about, one instance of the same "wrong message
  // sends the user down the wrong recovery path" concern this PR's own
  // 409-vs-refetch-failure distinction was built to avoid (#911 review, third
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

  // Re-reads the list after a 409, returning what the server sent.
  //
  // Ungated by previewGeneration — same rule as the successful-create
  // branch of handleCreateLift: a freshly refetched list is authoritative server
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
  // before this refetch resolves, `fetchedLifts` — a snapshot
  // the server returned for a request issued before that append —
  // won't contain it, and replacing wholesale would silently drop a
  // lift that was genuinely, successfully created just moments ago
  // (issue #921).
  //
  // Restoring a `prev` entry `fetchedLifts` doesn't know about is only
  // safe when `sessionCreatedLiftIds` confirms it's exactly that kind
  // of sibling-row race — not the *initial* server-fetched customLifts
  // prop, and not anything an earlier refetch returned. Without that
  // scope, this same merge would just as happily resurrect a lift that
  // was genuinely deleted server-side (e.g. via Settings, in another
  // tab) between entering local state and this refetch running —
  // trading #921's bug for the opposite one (#921 review).
  async function refetchCustomLifts(): Promise<CustomLiftResponse[]> {
    const fetchedLifts = await fetchCustomLifts();
    setCustomLifts((prev) => {
      const fetchedIds = new Set(fetchedLifts.map((l) => l.id));
      const missingButSessionCreated = prev.filter(
        (p) => !fetchedIds.has(p.id) && sessionCreatedLiftIds.current.has(p.id),
      );
      return [...fetchedLifts, ...missingButSessionCreated];
    });
    return fetchedLifts;
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
      const result = await createCustomLift({ name, classification });
      if (!result.ok) {
        // 409 branch only — the success branch below has its own, narrower
        // generation gating (a created lift is real, persisted server-side
        // data and must reach local state regardless of this preview's
        // fate; #911 review, fourth pass).
        if (previewGeneration.current !== startGeneration) return; // preview discarded mid-request
        // 409 — a lift with this name already exists. Re-fetch the live server
        // list rather than searching the render-scope `customLifts` closure,
        // which can be stale: two ambiguous rows sharing this name each get
        // their own independently-enabled "Create" button (busy only guards
        // its own row), so a second click before the first resolves would
        // otherwise find no local match even for a lift this session just
        // created — and a genuine cross-tab creation was never in the local
        // list at all (#911 review).
        //
        // Runs unconditionally, even for a ReservedLiftNameConflictError 409
        // (#917 review) — the client can't tell the two 409 causes apart
        // before refetching, and server-side the reserved-alias check
        // precedes the duplicate-name check (custom-lift.controller.ts), so a
        // reserved-name 409 can never actually have a matching custom lift
        // for this refetch to find. One avoidable GET on that specific error
        // path; not worth a cause discriminant just to skip it.
        let latest: CustomLiftResponse[] | null = null;
        let refetchFailed = false;
        try {
          latest = await refetchCustomLifts();
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
        // The not-refetch-failed branch renders the server's own conflict
        // message (result.conflictMessage) rather than a hardcoded string.
        // createCustomLift's 409 can mean one of two distinct, both-true
        // reasons — a genuine duplicate name (CustomLiftConflictError) or a
        // name that shadows a built-in canonical alias and can never become
        // a custom lift at all (ReservedLiftNameConflictError) — and
        // `existing` above only ever finds the first kind (a reserved name
        // is by definition never in this user's own custom-lift list).
        // Asserting "already exists" unconditionally would misreport the
        // second case outright (#911 review, eighth pass — which shipped a
        // generic "already exists or is reserved" hedge as a stopgap, true
        // for both causes but not distinguishing them). Rendering the
        // server's own per-cause message instead closes that gap for real
        // (#917).
        setCreateDraftError(
          rowIndex,
          refetchFailed
            ? "Couldn't confirm whether this name already exists — try again."
            : result.conflictMessage,
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
      //
      // Recorded in sessionCreatedLiftIds BEFORE the state update below (order
      // doesn't matter for correctness here — nothing reads the set until a
      // future 409 branch's merge — but recording the id alongside its own
      // creation, rather than separately, keeps the two from ever drifting
      // apart) so a sibling row's concurrent 409 self-heal can tell this
      // lift apart from one it should treat as possibly-deleted (#921 review).
      sessionCreatedLiftIds.current.add(result.data.id);
      setCustomLifts((prev) => [...prev, result.data]);
      if (previewGeneration.current !== startGeneration) return; // preview discarded mid-request
      applyResolvedLiftToMatchingRows(matchOriginalLift, result.data.id, rowIndex);
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
      setCreateDraftError(rowIndex, e instanceof Error ? e.message : 'Failed to create lift');
    }
  }

  // A dry run or commit rejected a lift this list says exists, so it was deleted elsewhere
  // (#1124). Replaces the list outright: no create can be in flight here, because Next
  // waits for them and Commit comes after Next. A row holding a dropped lift's id goes
  // back to the lift's name, which it shows and can create again.
  async function refreshCustomLiftsAfterRejection() {
    try {
      const latest = await fetchCustomLifts();
      const latestIds = new Set(latest.map((lift) => lift.id));
      const droppedNames = new Map(
        customLifts.filter((lift) => !latestIds.has(lift.id)).map((lift) => [lift.id, lift.name]),
      );
      setCustomLifts(latest);
      setLiftOverrides(
        (prev) => new Map([...prev].map(([row, lift]) => [row, droppedNames.get(lift) ?? lift])),
      );
    } catch (e) {
      logClientError('fetchCustomLifts', e, { programId });
    }
  }

  // The request a commit would send for the user's current Review choices.
  function buildCommitRequest(sourceFile: File): { file: File; opts?: CommitImportOpts } {
    const deltas = previewBody?.deltas ?? [];
    if (destination === 'training-maxes' && reviewMaxes !== null) {
      // Rebuild CSV from the edited maxes list so that inline weight edits and excluded rows
      // are authoritative at commit time. excludedKeys is enforced here (via filter) rather
      // than via the server-side excludeKeys param, because the rebuilt CSV already omits
      // those rows — passing excludeKeys on top would be redundant and error-prone.
      const activeMaxes = reviewMaxes.filter((r) => !excludedKeys.has(r.lift));
      // Review doesn't list a lift the file leaves unchanged, but the server still has
      // to see it to report it as skipped (#1123). Only a lift's first row goes back in:
      // an older duplicate would be written if the row ahead of it were dropped.
      const seenLifts = new Set(reviewMaxes.map((r) => r.lift));
      const unchangedMaxes = deltas
        .filter((d) => {
          if (d.kind !== 'skip' || seenLifts.has(naturalKeyOf(d))) return false;
          seenLifts.add(naturalKeyOf(d));
          return true;
        })
        .map((d) => ({ lift: naturalKeyOf(d), weight: d.after ?? '' }));
      const csv = buildTrainingMaxesCsv([...activeMaxes, ...unchangedMaxes]);
      // No column overrides: this CSV has canonical headers and rows from a preview
      // that already applied them. Sending them again would rename columns twice.
      return { file: new File([csv], sourceFile.name, { type: 'text/csv' }) };
    }
    const liftOverridesRecord: Record<number, string> = {};
    // Walks the CURRENT preview's rows, so an override left over from a
    // discarded preview is never sent (#911 review, second pass), nor one
    // for a row the user excluded (third pass). A row with no override
    // still goes through resolveLiftValue: its file text may differ from a
    // known name only by case, which the server's exact-case lookup rejects.
    for (const d of deltas) {
      if (d.status !== 'ambiguous' || d.rowIndex === undefined || excludedKeys.has(d.key)) continue;
      const resolved = resolveLiftValue(rowLiftText(d));
      if (resolved) liftOverridesRecord[d.rowIndex] = resolved;
    }
    // A goal file's only overrides are rows kept as custom lifts, none of them ambiguous (#1169).
    // An excluded row's stays out: if its lift was since deleted, the commit would reject it.
    if (destination === 'strength-goals') {
      for (const d of deltas) {
        const lift = d.rowIndex !== undefined ? liftOverrides.get(d.rowIndex) : undefined;
        if (lift && d.rowIndex !== undefined && !excludedKeys.has(d.key)) liftOverridesRecord[d.rowIndex] = lift;
      }
    }
    const excludeKeys = deltas.filter((d) => excludedKeys.has(d.key)).map(excludeKeyFor);
    return {
      file: sourceFile,
      opts: {
        overrides: Object.keys(columnOverridesRecord).length > 0 ? columnOverridesRecord : undefined,
        excludeKeys: excludeKeys.length > 0 ? excludeKeys : undefined,
        liftOverrides: Object.keys(liftOverridesRecord).length > 0 ? liftOverridesRecord : undefined,
        // Always, so a 1RM row goes to training maxes whether or not it was remapped.
        splitDest: destination === 'lift-records',
      },
    };
  }

  // Asks the server what this commit would do, so the Preview tiles report the result of
  // the user's excludes, remaps and edits rather than the file as uploaded (#1123).
  async function enterPreview() {
    if (!programId || !file || !destination) return;
    const request = buildCommitRequest(file);
    // The commit is blocked until unresolved rows are fixed, and they'd fail this dry
    // run too, so count the rest of the file around them.
    const unresolved = (previewBody?.deltas ?? []).filter(
      (d) => !excludedKeys.has(d.key) && (d.status === 'incomplete' || reviewCounts.needsLiftKeys.has(d.key)),
    );
    const opts: CommitImportOpts | undefined =
      unresolved.length > 0
        ? { ...request.opts, excludeKeys: [...(request.opts?.excludeKeys ?? []), ...unresolved.map(excludeKeyFor)] }
        : request.opts;
    const startGeneration = previewGeneration.current;
    setCommitErrors(null);
    setError(null);
    setBusy(true);
    try {
      const result = await dryRunImport(programId, request.file, destination, opts);
      if (previewGeneration.current !== startGeneration) return; // preview discarded mid-request
      setPlannedCommit(result.ok ? { ...request, counts: result.data } : null);
      if (!result.ok) setCommitErrors(result.errors);
      setStep(Step.PREVIEW);
      if (!result.ok && result.errors.some((e) => e.code === 'UNRECOGNIZED_LIFT')) {
        await refreshCustomLiftsAfterRejection();
      }
    } catch (e) {
      logClientError('dryRunImport', e, { programId, destination });
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!programId || !destination || !plannedCommit) return;
    setCommitErrors(null);
    setBusy(true);

    try {
      const result = await commitImport(programId, plannedCommit.file, destination, plannedCommit.opts);

      if (result.ok) {
        setBatchId(result.data.batchId);
        setCommitResult(result.data);
        // Tab previews taken before this commit no longer match what the server would compute.
        setTabPreviews({});
        setStep(Step.DONE);
      } else {
        setCommitErrors(result.errors);
        if (result.errors.some((e) => e.code === 'UNRECOGNIZED_LIFT')) {
          await refreshCustomLiftsAfterRejection();
        }
      }
    } catch (e) {
      logClientError('commitImport', e, { programId, destination });
      setCommitErrors([
        { row: 0, code: 'UNEXPECTED_ERROR', message: e instanceof Error ? e.message : 'Import failed' },
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
    resetFileState();
    setStep(Step.SOURCE);
    setSheetTabs(null);
    setTabChoices({});
    setTabPreviews({});
    setTabQueue([]);
    setTabIndex(0);
    setCompletedTabs([]);
  }

  // Clears everything tied to one file — shared by reset() and by moving on
  // to the next queued Google Sheets tab, which keeps the workbook state.
  function resetFileState() {
    // Bumped so an in-flight handleCreateLift from before this reset (only
    // reachable from the DONE step, so hard to hit, but not impossible — see
    // its own generation checks) can't repopulate liftOverrides/createDrafts
    // after this function just cleared them (#911 review, third pass).
    previewGeneration.current += 1;
    setFile(null);
    setPreview(null);
    setCommitResult(null);
    setCommitErrors(null);
    setError(null);
    setReviewMaxes(null);
    setKeptSpellings(new Set());
    setPlannedCommit(null);
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
          {currentTab && (
            <p className={styles.headerSubtitle}>
              Tab {tabIndex + 1} of {tabQueue.length}: {currentTab.name}
            </p>
          )}
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
              {programsLoadFailed && (
                <p className={styles.errorNote}>
                  We couldn&apos;t load all of your programs, so this list may be incomplete. Reload
                  the page to try again.
                </p>
              )}
              {programs.length === 0 ? (
                !programsLoadFailed && (
                  <p className={styles.infoBox}>
                    You don&apos;t have a program yet.{' '}
                    <Link href="/programs">Choose one</Link> to import into.
                  </p>
                )
              ) : (
                <div className={styles.field}>
                  <label htmlFor="import-program" className={styles.fieldLabel}>
                    Program
                  </label>
                  <select
                    id="import-program"
                    className={styles.select}
                    value={programId}
                    onChange={(e) => selectProgram(e.target.value)}
                  >
                    {programs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.isTemplate ? `${p.name} (template)` : p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <fieldset className={`${styles.field} ${styles.sourceFieldset}`}>
                <legend className={styles.fieldLabel}>Import from</legend>
                <div className={styles.chipRow}>
                  <label>
                    <input
                      type="radio"
                      name="import-source"
                      checked={sourceMode === 'file'}
                      onChange={() => {
                        setSourceMode('file');
                        setError(null);
                      }}
                    />{' '}
                    Upload a CSV
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="import-source"
                      checked={sourceMode === 'sheet'}
                      onChange={() => {
                        setSourceMode('sheet');
                        setError(null);
                      }}
                    />{' '}
                    Google Sheets
                  </label>
                </div>
              </fieldset>
              {sourceMode === 'file' ? (
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
              ) : (
                <>
                  <div className={styles.field}>
                    <label htmlFor="import-sheet-url" className={styles.fieldLabel}>
                      Google Sheets link
                    </label>
                    <input
                      id="import-sheet-url"
                      type="url"
                      className={styles.select}
                      placeholder="https://docs.google.com/spreadsheets/d/…"
                      value={sheetUrl}
                      disabled={busy}
                      onChange={(e) => {
                        setSheetUrl(e.target.value);
                        setSheetTabs(null);
                        setTabPreviews({});
                      }}
                    />
                    <p className={styles.stepHint}>
                      The sheet must be shared as &ldquo;Anyone with the link&rdquo; (Viewer) so we
                      can read it. Anyone holding the link can then view it — you can turn sharing
                      back off after importing.
                    </p>
                  </div>
                  {sheetTabs && (
                    <SheetTabsStep
                      workbookId={workbookId}
                      programId={programId}
                      tabs={sheetTabs}
                      kinds={availableKinds}
                      choices={tabChoices}
                      onChange={setTabChoices}
                      previews={tabPreviews}
                      setPreviews={setTabPreviews}
                    />
                  )}
                </>
              )}
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
                  {destinationUnavailable && (
                    <p className={styles.infoBox}>
                      A program file can only be imported into a custom program, because it rewrites
                      the program&apos;s lifts and sets. Go back and pick a custom program, or{' '}
                      <Link href="/programs">create one</Link>.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <p className={styles.stepHint}>
                    We couldn&apos;t confidently tell what this file is. Pick a destination,
                    or skip it.
                    {selectedProgram?.isTemplate &&
                      ' A program file needs a custom program, so that option is hidden for this template.'}
                  </p>
                  <div className={styles.candidateList}>
                    {availableKinds.map((kind) => {
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
                                // A change while the preview runs would leave Review showing a
                                // different mapping from the one the commit sends.
                                disabled={busy}
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
              {error && <p className={styles.errorNote}>{error}</p>}
            </>
          )}

          {/* ── REVIEW ── */}
          {step === Step.REVIEW && preview && (
            // Disabled during the dry run: Commit sends the request it previewed, so an
            // edit made while it's in flight would be left out of the commit (#1123).
            <fieldset className={styles.reviewFields} disabled={busy}>
              <h2 className={styles.stepTitle}>Review</h2>
              {reviewEditsDiscarded && (
                <p className={styles.infoBox}>
                  Changing a column reloaded this file&apos;s rows, so your earlier exclusions, lift
                  choices and weight edits were cleared.
                </p>
              )}

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
                      {previewBody.spellingCollisions?.map((collision) => (
                        <SpellingCollisionNotice
                          key={collision.key}
                          label={collision.label}
                          kind="max"
                          rows={remainingCollisionRows(collision, keptSpellings).map((row) => ({
                            ...row,
                            value: `${row.weight} lbs`,
                            date: row.dateUpdated,
                          }))}
                          onKeep={(row, name, classification) =>
                            handleKeepAsCustom('max', name, classification, (lift) => {
                              applyKeptRow(collision, row, lift);
                              return null;
                            })
                          }
                        />
                      ))}
                      <ul className={styles.maxEditList} aria-label="Training maxes to import">
                        {reviewMaxes
                          .filter((row) => !excludedKeys.has(row.lift))
                          .map((row) => {
                            const liftName = row.label;
                            return (
                            <li key={row.lift} className={styles.maxEditRow}>
                              <span className={styles.maxEditLift}>{liftName}</span>
                              <input
                                type="number"
                                className={styles.maxEditWeight}
                                value={row.weight}
                                min={1}
                                step="0.01"
                                aria-label={`Weight for ${liftName}`}
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
                                aria-label={`Remove ${liftName}`}
                              >
                                ×
                              </button>
                            </li>
                            );
                          })}
                      </ul>
                      {reviewMaxes.filter((r) => !excludedKeys.has(r.lift)).length === 0 && (
                        <p className={styles.infoBox}>All rows removed. Nothing will be imported.</p>
                      )}
                    </>
                  ) : (
                    <>
                      {previewBody.goalSpellingCollisions?.map((collision) => (
                        <SpellingCollisionNotice
                          key={collision.key}
                          kind="goal"
                          label={collision.label}
                          rows={writtenGoalRows(collision)}
                          onKeep={(row, name, classification) =>
                            handleKeepAsCustom('goal', name, classification, (lift) => keepGoalRow(row, lift))
                          }
                        />
                      ))}
                      {/* These rows can sit at the end of thousands, and the commit
                          rejects the whole file until each is fixed or excluded (#1114). */}
                      {needsLiftCount > 0 && (
                        <div className={styles.infoBox}>
                          <p>
                            {needsLiftCount === 1 ? '1 row needs a lift' : `${needsLiftCount} rows need a lift`}{' '}
                            before this file can be imported. Pick or create a lift for each one,
                            or exclude it.
                          </p>
                          <button
                            type="button"
                            className={styles.btnSecondary}
                            onClick={() => {
                              setNeedsLiftSnapshot(reviewCounts.needsLiftKeys);
                              setReviewFilter('needs-lift');
                            }}
                          >
                            Show rows that need a lift
                          </button>
                        </div>
                      )}
                      {reviewCounts.incomplete > 0 && (
                        <div className={styles.infoBox}>
                          <p>
                            {reviewCounts.incomplete === 1
                              ? '1 row is missing a required value'
                              : `${reviewCounts.incomplete} rows are missing a required value`}
                            . Exclude {reviewCounts.incomplete === 1 ? 'it' : 'them'}, or correct
                            the file and upload it again.
                          </p>
                          <button
                            type="button"
                            className={styles.btnSecondary}
                            onClick={() => setReviewFilter('incomplete')}
                          >
                            Show incomplete rows
                          </button>
                        </div>
                      )}

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

                      {/* Lift catalog datalist for ambiguous rows: DEFAULT_SLOT_MAP's
                          names (ALL_SLOT_MAP_ALIASES), every catalog lift's display
                          name (#1116), and this user's custom lifts (#911). A
                          catalog id still resolves when typed; it isn't listed
                          because each lift would then show up twice. Deduplicated
                          on the exact value: a custom lift with a built-in's exact
                          name would otherwise list that name twice. A case variant
                          ("squat" vs. "Squat") stays listed, because it is a
                          distinct, reachable key on the server (#911 review, third
                          pass). */}
                      <datalist id="lift-catalog">
                        {[
                          ...new Set([
                            ...ALL_SLOT_MAP_ALIASES,
                            ...LIFT_CATALOG.map((lift) => lift.name),
                            ...customLifts.map((lift) => lift.name),
                          ]),
                        ].map((name) => (
                          <option key={name} value={name} />
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
                            // The API names a lift once, so rows spelling it differently would
                            // read the same. They read as the file wrote them (#1169).
                            const rowLabel = (rowIndex !== undefined && goalRowSpellings.get(rowIndex)) || d.label;
                            // rawLiftValue (untrimmed) drives the controlled input's `value` —
                            // trimming it there would eat a just-typed trailing space on every
                            // keystroke, breaking multi-word names. currentLiftValue (trimmed)
                            // is for comparisons only (empty-check, knownLiftNames lookup).
                            const storedLiftValue = rowLiftText(d);
                            const rawLiftValue = customLiftNames.get(storedLiftValue) ?? storedLiftValue;
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
                                    aria-label={`Select ${rowLabel}`}
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
                                          // A cleared row stays unresolved, which
                                          // blocks the commit until it's fixed or
                                          // excluded.
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
                                            new lift
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
                                              aria-label={`Create "${currentLiftValue}" as a new lift`}
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
                                    rowLabel
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
                                      aria-label={`Exclude ${rowLabel}`}
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
                                      aria-label={`Re-include ${rowLabel}`}
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
              {error && <p className={styles.errorNote}>{error}</p>}
            </fieldset>
          )}

          {/* ── PREVIEW ── */}
          {step === Step.PREVIEW && previewBody && (
            <>
              <h2 className={styles.stepTitle}>Preview changes</h2>
              <div className={styles.countRow} data-testid="import-counts">
                {plannedCommit && (
                  <>
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{plannedCommit.counts.created}</span>
                      <span className={styles.countLabel}>Create</span>
                    </div>
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{plannedCommit.counts.updated}</span>
                      <span className={styles.countLabel}>Update</span>
                    </div>
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{plannedCommit.counts.skipped}</span>
                      <span className={styles.countLabel}>Skip</span>
                    </div>
                  </>
                )}
                {unresolvedCount > 0 && (
                  <div className={styles.countPill}>
                    <span className={styles.countValue}>{unresolvedCount}</span>
                    <span className={styles.countLabel}>Unresolved</span>
                  </div>
                )}
              </div>

              {unresolvedCount > 0 && (
                <p className={styles.errorNote}>
                  This file can&apos;t be imported until {unresolvedCount === 1 ? 'that row is' : 'those rows are'}{' '}
                  fixed or excluded. Go back to Review to resolve {unresolvedCount === 1 ? 'it' : 'them'}.
                </p>
              )}

              {plannedCommit?.counts.split && (
                <div className={styles.splitCard}>
                  <p className={styles.stepHint}>
                    Also routing to {KIND_LABEL[plannedCommit.counts.split.destination]}:
                  </p>
                  <div className={styles.countRow} data-testid="import-split-counts">
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{plannedCommit.counts.split.created}</span>
                      <span className={styles.countLabel}>Create</span>
                    </div>
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{plannedCommit.counts.split.updated}</span>
                      <span className={styles.countLabel}>Update</span>
                    </div>
                    <div className={styles.countPill}>
                      <span className={styles.countValue}>{plannedCommit.counts.split.skipped}</span>
                      <span className={styles.countLabel}>Skip</span>
                    </div>
                  </div>
                </div>
              )}

              {commitErrors && (
                <div className={styles.errorBox}>
                  <strong>{plannedCommit ? 'Commit failed:' : "This file can't be imported yet:"}</strong>
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
                        Row {s.row}: {s.label}
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

              {/* Imported lifts with no training max (#1273). Gone once undone: the sets are too. */}
              {commitResult.destination === 'lift-records' &&
                commitResult.lifts &&
                commitResult.lifts.length > 0 &&
                undoResult === null && (
                  <ImportMissingMaxes
                    key={commitResult.batchId}
                    program={programId}
                    lifts={commitResult.lifts}
                    preferredUnit={unit}
                  />
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

              {sourceMode === 'sheet' && completedTabs.length > 0 && (
                <div>
                  {/* Every tab imported this session, including from an earlier fetch, so each keeps its Undo. */}
                  <p className={styles.stepHint}>Tabs imported earlier</p>
                  <ul className={styles.skippedDetailList}>
                    {completedTabs.map((t, i) => (
                      // A tab can be committed again after an undo, so the name alone is not unique.
                      <li key={`${t.name}:${t.kind}:${i}`}>
                        {t.name} — {KIND_LABEL[t.result.destination]}: {t.result.created} created,{' '}
                        {t.result.updated} updated, {t.result.skipped} skipped.{' '}
                        {t.undo ? (
                          <span>Undone ({t.undo.restored} restored).</span>
                        ) : (
                          t.batchId && (
                            <button
                              type="button"
                              className={styles.undoBtn}
                              onClick={() => handleUndoCompletedTab(t)}
                              disabled={busy}
                            >
                              Undo {t.name}
                            </button>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
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
              onClick={() => {
                setError(null);
                setStep((step === Step.CLASSIFY ? Step.SOURCE : step - 1) as typeof Step[keyof typeof Step]);
              }}
              disabled={busy}
            >
              Back
            </button>
          )}

          {step === Step.SOURCE && sourceMode === 'file' && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={handleAnalyze}
              disabled={!programId || !file || busy}
            >
              Analyze
            </button>
          )}

          {step === Step.SOURCE && sourceMode === 'sheet' && !sheetTabs && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={handleFetchSheet}
              disabled={!programId || !sheetUrl.trim() || busy}
            >
              {busy ? 'Fetching…' : 'Fetch workbook'}
            </button>
          )}

          {step === Step.SOURCE && sourceMode === 'sheet' && sheetTabs && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={handleStartSheetImport}
              disabled={!programId || pendingSheetTabs.length === 0 || busy}
            >
              Import {pendingSheetTabs.length} tab{pendingSheetTabs.length === 1 ? '' : 's'}
            </button>
          )}

          {step === Step.CLASSIFY && destination && !destinationUnavailable && (
            <button type="button" className={styles.btnPrimary} onClick={() => setStep(Step.MAP_COLUMNS)}>
              Next
            </button>
          )}

          {step === Step.MAP_COLUMNS && (
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={!allRequiredMapped || busy}
              onClick={enterReview}
            >
              Next
            </button>
          )}

          {step === Step.REVIEW && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={enterPreview}
              disabled={
                busy ||
                // A create resolving after the dry run would change what Commit should send.
                busyLiftNames.size > 0 ||
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
              disabled={busy || !plannedCommit || unresolvedCount > 0}
            >
              {busy ? 'Importing…' : 'Commit import'}
            </button>
          )}

          {step === Step.DONE && nextTab && (
            <button type="button" className={styles.btnPrimary} onClick={handleNextTab} disabled={busy}>
              Next tab: {nextTab.name}
            </button>
          )}

          {step === Step.DONE && !nextTab && (
            <button type="button" className={styles.btnPrimary} onClick={reset}>
              Import another file
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
