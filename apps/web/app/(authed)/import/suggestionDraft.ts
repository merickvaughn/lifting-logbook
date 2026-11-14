import type { ImportAssignResponse, ImportSuggestion } from '@lifting-logbook/types';
import {
  canFile,
  choicesFor,
  fileSession,
  joinWithPrevious,
  pendingSessions,
  setProgram,
  setStatus,
  splitAt,
  type AssignDraft,
  type DraftStretch,
} from './assignDraft';

/**
 * LLM suggestions at the Assign step (#1174, proposal decision 12), against the lifter's draft.
 * Each suggestion was made about the rules' grouping, anchored to its session dates. The lifter
 * may have edited the draft since, even while the request was pending, so a suggestion counts
 * only while the part of the draft it's about is still as the rules left it. Every function here
 * is pure.
 */

/** The stretch, still as the rules suggested it, that starts on `date`. */
function untouchedStartingOn(draft: AssignDraft, date: string): { stretch: DraftStretch; index: number } | null {
  const index = draft.stretches.findIndex((s) => s.source !== null && s.source.startDate === date && s.sessions[0]?.date === date);
  const stretch = draft.stretches[index];
  return stretch ? { stretch, index } : null;
}

/** Whether accepting the suggestion would still do what it says to the draft as it is now. */
export function suggestionApplies(s: ImportSuggestion, draft: AssignDraft, res: ImportAssignResponse): boolean {
  switch (s.kind) {
    case 'boundary': {
      // An export's macrocycles are its own: there's no boundary to move.
      if (res.exported) return false;
      if (s.action === 'add') {
        return draft.stretches.some(
          (x) => x.source !== null && x.sessions[0]?.date !== s.date && x.sessions.some((y) => y.date === s.date),
        );
      }
      const found = untouchedStartingOn(draft, s.date);
      return found !== null && found.index > 0 && draft.stretches[found.index - 1]?.source != null;
    }
    case 'lone': {
      const pending = pendingSessions(res).find((p) => p.session.date === s.date);
      if (!pending || draft.filed[s.date] !== undefined) return false;
      if (!choicesFor(pending, res).includes(s.choice)) return false;
      return (s.choice !== 'earlier' && s.choice !== 'later') || canFile(draft, s.date, s.choice);
    }
    case 'status': {
      const found = untouchedStartingOn(draft, s.stretchStart);
      return found !== null && !found.stretch.statusChosen && found.stretch.status !== s.status;
    }
    case 'program': {
      const found = untouchedStartingOn(draft, s.stretchStart);
      return (
        found !== null &&
        found.stretch.program === found.stretch.source?.program &&
        found.stretch.program !== s.program
      );
    }
    case 'note':
      return true;
  }
}

/** The draft with the suggestion accepted. Unchanged when it no longer applies. */
export function acceptSuggestion(s: ImportSuggestion, draft: AssignDraft, res: ImportAssignResponse): AssignDraft {
  if (!suggestionApplies(s, draft, res)) return draft;
  switch (s.kind) {
    case 'boundary': {
      if (s.action === 'add') {
        const into = draft.stretches.find((x) => x.sessions.some((y) => y.date === s.date));
        return into ? splitAt(draft, into.id, s.date) : draft;
      }
      const found = untouchedStartingOn(draft, s.date);
      return found ? joinWithPrevious(draft, found.stretch.id) : draft;
    }
    case 'lone':
      return fileSession(draft, s.date, s.choice);
    case 'status': {
      const found = untouchedStartingOn(draft, s.stretchStart);
      return found ? setStatus(draft, found.stretch.id, s.status) : draft;
    }
    case 'program': {
      const found = untouchedStartingOn(draft, s.stretchStart);
      return found ? setProgram(draft, found.stretch.id, s.program) : draft;
    }
    case 'note':
      // A note changes nothing (decision 12): it can only be dismissed.
      return draft;
  }
}
