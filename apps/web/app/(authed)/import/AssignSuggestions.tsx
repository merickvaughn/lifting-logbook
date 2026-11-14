'use client';

import { useEffect, useRef } from 'react';
import type { ImportAssignResponse, ImportSuggestion, ImportSuggestionsResponse } from '@lifting-logbook/types';
import { STATUS_LABEL } from '@/lib/macrocycleStatus';
import { fmtDay, type AssignDraft } from './assignDraft';
import { acceptSuggestion, suggestionApplies } from './suggestionDraft';
import styles from './AssignStep.module.css';

/**
 * Where the lifter is with the Assign step's optional LLM suggestions (#1174). The wizard owns it,
 * so a pending request outlives a re-render and is aborted when the lifter leaves the step.
 *
 * - `unasked`: the question is showing. Nothing has been sent.
 * - `declined`: the lifter said not this time.
 * - `pending`: the request is out.
 * - `done`: it came back; `result` is null when the request itself failed.
 */
export type SuggestState =
  | { phase: 'unasked' }
  | { phase: 'declined' }
  | { phase: 'pending'; notes: boolean }
  | { phase: 'done'; notes: boolean; result: ImportSuggestionsResponse | null };

export type SuggestionAnswer = 'accepted' | 'dismissed';

const CHOICE_TEXT = {
  earlier: 'with the earlier macrocycle',
  later: 'with the later macrocycle',
  'non-cycle': 'as a non-cycle workout',
  exclude: 'by leaving it out',
} as const;

/** Why the server dropped some, for one suggestion or several. */
const DROP_TEXT = {
  malformed: (one: boolean) => (one ? 'it wasn’t readable' : 'they weren’t readable'),
  'unknown-lift': (one: boolean) =>
    one ? 'it named a lift that isn’t in this file' : 'they named lifts that aren’t in this file',
  'out-of-range': (one: boolean) =>
    one ? 'it didn’t fit the workouts in this file' : 'they didn’t fit the workouts in this file',
} as const;

/** What a suggestion would do, in words, which also names its Accept and Dismiss buttons. */
function describe(s: ImportSuggestion, programName: (id: string) => string, draft: AssignDraft): string {
  const stretchAt = (date: string) => {
    const found = draft.stretches.find((x) => x.sessions[0]?.date === date);
    return `${found ? programName(found.program) : 'The macrocycle'} from ${fmtDay(date)}`;
  };
  switch (s.kind) {
    case 'boundary':
      return s.action === 'add'
        ? `Start a new macrocycle on ${fmtDay(s.date)}`
        : `Join ${stretchAt(s.date)} with the macrocycle before it`;
    case 'lone':
      return `File the ${fmtDay(s.date)} workout ${CHOICE_TEXT[s.choice]}`;
    case 'status':
      return `Mark ${stretchAt(s.stretchStart)} as ${STATUS_LABEL[s.status]}`;
    case 'program':
      return `Set the program of ${stretchAt(s.stretchStart)} to ${programName(s.program)}`;
    case 'note':
      return s.from && s.to
        ? `Note on ${fmtDay(s.from)} to ${fmtDay(s.to)}`
        : s.from
          ? `Note on ${fmtDay(s.from)}`
          : 'Note';
  }
}

function Panel({ children, labelledBy }: { children: React.ReactNode; labelledBy: string }) {
  return (
    <section className={styles.panel} aria-labelledby={labelledBy} data-testid="assign-suggestions">
      <p className={styles.eyebrow} id={labelledBy}>
        SUGGESTIONS FROM AN AI MODEL
      </p>
      {children}
    </section>
  );
}

const EYEBROW_ID = 'assign-suggestions-heading';

/**
 * The Assign step's LLM suggestions (#1174, proposal decision 12). With a provider configured it
 * asks once per import, yes by default, and sends nothing until the lifter answers. Continue never
 * waits on it. Each suggestion is checked against the lifter's draft as it is now, so one their
 * edits have made out of date is dropped and counted rather than shown.
 */
export default function AssignSuggestions({
  res,
  draft,
  onChange,
  programName,
  state,
  notes,
  onNotesChange,
  onAnswer,
  answers,
  onAnswerSuggestion,
  focusYes,
}: {
  res: ImportAssignResponse;
  draft: AssignDraft;
  onChange: (next: AssignDraft) => void;
  programName: (id: string) => string;
  state: SuggestState;
  /** The notes choice, off by default. */
  notes: boolean;
  onNotesChange: (notes: boolean) => void;
  onAnswer: (yes: boolean) => void;
  /** The lifter's answer to each suggestion, by its index in the response. */
  answers: Readonly<Record<number, SuggestionAnswer>>;
  onAnswerSuggestion: (index: number, answer: SuggestionAnswer) => void;
  /** Move focus to Yes: the question has just appeared with a fresh grouping. */
  focusYes: boolean;
}) {
  const yesRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusYes && state.phase === 'unasked') yesRef.current?.focus();
  }, [focusYes, state.phase]);

  // No provider: suggestions are off, and the step looks as it does without them.
  if (!res.suggestions) return null;
  const provider = res.suggestions.provider;

  if (state.phase === 'unasked') {
    return (
      <Panel labelledBy={EYEBROW_ID}>
        <p>
          Use suggestions from {provider}? It receives your sets (date, lift name, set number, weight and reps) and
          the groupings below. A very long file sends every set around breaks and a summary of the rest. Custom lift
          and program names are replaced with placeholders. Nothing is sent until you answer, and you can continue
          without answering.
        </p>
        <label>
          <input type="checkbox" checked={notes} onChange={(e) => onNotesChange(e.target.checked)} /> Include my
          workout notes. Off by default.
        </label>
        <div className={styles.options}>
          <button ref={yesRef} type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => onAnswer(true)}>
            Yes, use suggestions
          </button>
          <button type="button" className={styles.btn} onClick={() => onAnswer(false)}>
            Not this time
          </button>
        </div>
      </Panel>
    );
  }
  if (state.phase === 'declined') {
    return (
      <Panel labelledBy={EYEBROW_ID}>
        <p>No suggestions for this import. Nothing was sent.</p>
      </Panel>
    );
  }
  if (state.phase === 'pending') {
    return (
      <Panel labelledBy={EYEBROW_ID}>
        <p role="status">
          Looking for suggestions. You can carry on: everything below is already complete without them.
        </p>
      </Panel>
    );
  }

  const result = state.result;
  if (result === null || result.status === 'unavailable' || result.status === 'off') {
    return (
      <Panel labelledBy={EYEBROW_ID}>
        <p role="status">
          Suggestions aren’t available right now. Everything below comes from your dates and is complete without them.
        </p>
      </Panel>
    );
  }
  if (result.status === 'limited') {
    return (
      <Panel labelledBy={EYEBROW_ID}>
        <p role="status">
          You’ve asked for suggestions as many times as you can this hour. Try again in {result.retryAfterMinutes}{' '}
          minute{result.retryAfterMinutes === 1 ? '' : 's'}. Everything below is complete without them.
        </p>
      </Panel>
    );
  }
  if (result.status === 'too-large') {
    return (
      <Panel labelledBy={EYEBROW_ID}>
        <p role="status">
          This file is too long to send for suggestions, even with summaries: {result.sets} sets, over the{' '}
          {result.limit} a request can carry. Nothing was sent.
        </p>
      </Panel>
    );
  }

  const shown: Array<{ s: ImportSuggestion; index: number }> = [];
  let outOfDate = 0;
  result.suggestions.forEach((s, index) => {
    if (answers[index] !== undefined || suggestionApplies(s, draft, res)) shown.push({ s, index });
    else outOfDate++;
  });
  const drops = (Object.keys(DROP_TEXT) as Array<keyof typeof DROP_TEXT>).filter((k) => result.dropped[k] > 0);

  return (
    <Panel labelledBy={EYEBROW_ID}>
      <p role="status">
        {result.suggestions.length === 0
          ? `${result.provider} had no suggestions. Everything below comes from your dates.`
          : 'Suggestions only. Nothing changes unless you accept it.'}
      </p>
      <p className={styles.reason}>{state.notes ? 'Your notes were included.' : 'Your notes weren’t sent.'}</p>
      {shown.length > 0 && (
        <ul className={styles.list} aria-label="Suggestions">
          {shown.map(({ s, index }) => {
            const what = describe(s, programName, draft);
            const answer = answers[index];
            const itemId = `assign-suggestion-${index}`;
            return (
              <li key={index} id={itemId} tabIndex={-1} data-testid="assign-suggestion">
                <p className={styles.heading}>{what}</p>
                <p className={styles.reason}>{s.kind === 'note' ? s.text : s.reason}</p>
                {answer ? (
                  <p className={styles.reason}>{answer === 'accepted' ? 'Accepted.' : 'Dismissed.'}</p>
                ) : (
                  <div className={styles.options}>
                    {/* A note changes nothing, so it can only be dismissed (decision 12). */}
                    {s.kind !== 'note' && (
                      <button
                        type="button"
                        className={styles.btn}
                        aria-label={`Accept: ${what}`}
                        onClick={() => {
                          onChange(acceptSuggestion(s, draft, res));
                          onAnswerSuggestion(index, 'accepted');
                          document.getElementById(itemId)?.focus();
                        }}
                      >
                        Accept
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.btn}
                      aria-label={`Dismiss: ${what}`}
                      onClick={() => {
                        onAnswerSuggestion(index, 'dismissed');
                        document.getElementById(itemId)?.focus();
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {outOfDate > 0 && (
        <p className={styles.reason} data-testid="assign-suggestions-out-of-date">
          {outOfDate} suggestion{outOfDate === 1 ? ' was' : 's were'} dropped because your changes left{' '}
          {outOfDate === 1 ? 'it' : 'them'} out of date.
        </p>
      )}
      {drops.map((k) => (
        <p key={k} className={styles.reason} data-testid={`assign-suggestions-dropped-${k}`}>
          {result.dropped[k]} other suggestion{result.dropped[k] === 1 ? ' was' : 's were'} dropped because{' '}
          {DROP_TEXT[k](result.dropped[k] === 1)}.
        </p>
      ))}
    </Panel>
  );
}
