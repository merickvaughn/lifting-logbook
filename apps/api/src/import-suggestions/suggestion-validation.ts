import type {
  AssignStretchStatus,
  ImportSuggestion,
  ImportSuggestionDropReason,
  ImportSuggestionSessionChoice,
} from '@lifting-logbook/types';
import type { SegmentedLiftHistory } from '@lifting-logbook/core';
import type { BuiltSuggestionPayload, SuggestionRow } from './suggestion-payload';

/**
 * Checks what a model returned against the file's parsed rows and the rules' grouping (#1174,
 * proposal decision 12). Whatever it returns, the rules' grouping is only read here, never changed:
 * a suggestion that doesn't hold is dropped and counted, and the rest go to the lifter to accept
 * or dismiss. Pure.
 */

/** The longest reason or note shown to the lifter. A longer one is dropped as malformed. */
export const MAX_SUGGESTION_TEXT = 500;
/** The most suggestions kept from one response; any past it are dropped as out of range. */
export const MAX_SUGGESTIONS = 40;

const STATUSES: readonly AssignStretchStatus[] = ['in-progress', 'completed', 'overran', 'abandoned'];
const CHOICES: readonly ImportSuggestionSessionChoice[] = ['earlier', 'later', 'non-cycle', 'exclude'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidatedSuggestions {
  suggestions: ImportSuggestion[];
  dropped: Record<ImportSuggestionDropReason, number>;
}

const ymd = (date: Date) => date.toISOString().slice(0, 10);

export function validateSuggestions(
  output: unknown,
  segmented: SegmentedLiftHistory<SuggestionRow>,
  built: Pick<BuiltSuggestionPayload, 'lifts' | 'programs' | 'placeholders'>,
  exported: boolean,
): ValidatedSuggestions {
  const dropped: Record<ImportSuggestionDropReason, number> = { malformed: 0, 'unknown-lift': 0, 'out-of-range': 0 };
  const items = isRecord(output) && Array.isArray(output.suggestions) ? output.suggestions : null;
  // A response that isn't the object asked for is one malformed answer.
  if (items === null) {
    dropped.malformed = 1;
    return { suggestions: [], dropped };
  }

  // Each stretch by its first session's date. Two stretches can start on one day in a file with
  // overlapping numbers, and a date that names both names neither.
  const starts = new Map<string, number>();
  segmented.stretches.forEach((s) => {
    const day = ymd(s.startDate);
    starts.set(day, (starts.get(day) ?? 0) + 1);
  });
  const firstStart = segmented.stretches[0] ? ymd(segmented.stretches[0].startDate) : null;
  const inStretch = new Set(segmented.stretches.flatMap((s) => s.sessions.map((x) => ymd(x.date))));
  const lone = new Set(segmented.lone.map((l) => ymd(l.session.date)));
  const unnumbered = new Set(
    segmented.unnumbered.flatMap((row) => (row.date instanceof Date ? [ymd(row.date)] : [])),
  );
  const allDates = new Set([...inStretch, ...lone, ...unnumbered]);

  const restore = (text: string) => {
    let out = text;
    for (const [placeholder, real] of built.placeholders) out = out.split(placeholder).join(real);
    return out;
  };

  const suggestions: ImportSuggestion[] = [];
  for (const item of items) {
    const result = check(item);
    if (typeof result === 'string') {
      dropped[result]++;
    } else if (suggestions.length >= MAX_SUGGESTIONS) {
      dropped['out-of-range']++;
    } else {
      suggestions.push(result);
    }
  }
  return { suggestions, dropped };

  function check(item: unknown): ImportSuggestion | ImportSuggestionDropReason {
    if (!isRecord(item) || typeof item.kind !== 'string') return 'malformed';
    if (item.lifts !== undefined) {
      if (!Array.isArray(item.lifts) || !item.lifts.every((l) => typeof l === 'string')) return 'malformed';
      if (!item.lifts.every((l: string) => built.lifts.has(l.trim().toLowerCase()))) return 'unknown-lift';
    }
    const textField = item.kind === 'note' ? item.text : item.reason;
    if (typeof textField !== 'string' || textField.trim() === '' || textField.length > MAX_SUGGESTION_TEXT) {
      return 'malformed';
    }
    const text = restore(textField.trim());

    switch (item.kind) {
      case 'boundary': {
        if ((item.action !== 'add' && item.action !== 'remove') || !isDate(item.date)) return 'malformed';
        // An export's macrocycles are its own, so there's no boundary to move (decision 8).
        if (exported) return 'out-of-range';
        const date = item.date;
        if (item.action === 'add') {
          if (!inStretch.has(date) || starts.has(date)) return 'out-of-range';
        } else if (starts.get(date) !== 1 || date === firstStart) {
          return 'out-of-range';
        }
        return { kind: 'boundary', action: item.action, date, reason: text };
      }
      case 'lone': {
        if (!isDate(item.date) || typeof item.choice !== 'string') return 'malformed';
        if (!(CHOICES as readonly string[]).includes(item.choice)) return 'out-of-range';
        const choice = item.choice as ImportSuggestionSessionChoice;
        const date = item.date;
        if (!lone.has(date) && !unnumbered.has(date)) return 'out-of-range';
        // An export's session with no number can't join a stretch sent as file numbers.
        if (exported && unnumbered.has(date) && (choice === 'earlier' || choice === 'later')) return 'out-of-range';
        return { kind: 'lone', date, choice, reason: text };
      }
      case 'status': {
        if (!isDate(item.stretchStart) || typeof item.status !== 'string') return 'malformed';
        const stretch = startingOn(item.stretchStart);
        if (!stretch || !(STATUSES as readonly string[]).includes(item.status)) return 'out-of-range';
        // One that changes nothing isn't a suggestion.
        if (stretch.status === item.status) return 'out-of-range';
        return { kind: 'status', stretchStart: item.stretchStart, status: item.status as AssignStretchStatus, reason: text };
      }
      case 'program': {
        if (!isDate(item.stretchStart) || typeof item.program !== 'string') return 'malformed';
        const stretch = startingOn(item.stretchStart);
        const program = built.programs.get(item.program.trim());
        if (!stretch || program === undefined || stretch.program === program) return 'out-of-range';
        return { kind: 'program', stretchStart: item.stretchStart, program, reason: text };
      }
      case 'note': {
        const from = item.from ?? null;
        const to = item.to ?? null;
        if ((from !== null && !isDate(from)) || (to !== null && !isDate(to))) return 'malformed';
        if ((from !== null && !inFile(from)) || (to !== null && !inFile(to))) return 'out-of-range';
        return { kind: 'note', from, to, text };
      }
      default:
        return 'malformed';
    }
  }

  /** The one stretch starting on `date`, if exactly one does. */
  function startingOn(date: string) {
    return starts.get(date) === 1 ? segmented.stretches.find((s) => ymd(s.startDate) === date) : undefined;
  }

  // A note may name any day from the file's first session to its last.
  function inFile(date: string): boolean {
    const sorted = [...allDates].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return first !== undefined && last !== undefined && date >= first && date <= last;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
