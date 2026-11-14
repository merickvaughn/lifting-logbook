import type { AssignStretchStatus, ImportSuggestion, ImportSuggestionSessionChoice } from '@lifting-logbook/types';

// The response's closed value sets, written once for the prompt, the schema and the validator. Each
// is built from a `Record` over its type, so a value the type gains or loses is a compile error here.
const valuesOf = <T extends string>(all: Record<T, true>) => Object.keys(all) as T[];
export const SUGGESTION_KINDS = valuesOf<ImportSuggestion['kind']>({ boundary: true, lone: true, status: true, program: true, note: true });
export const BOUNDARY_ACTIONS = valuesOf<Extract<ImportSuggestion, { kind: 'boundary' }>['action']>({ add: true, remove: true });
export const SESSION_CHOICES = valuesOf<ImportSuggestionSessionChoice>({ earlier: true, later: true, 'non-cycle': true, exclude: true });
export const STRETCH_STATUSES = valuesOf<AssignStretchStatus>({ 'in-progress': true, completed: true, overran: true, abandoned: true });

const oneOf = (values: readonly string[]) => values.map((v) => `"${v}"`).join(' | ');

/**
 * The instructions sent with every import suggestion request (#1174). They hold none of the
 * lifter's data, which goes in the payload. The response is validated whatever the model does, so
 * this asks for the shape and the validation enforces it.
 *
 * The prompt asks for less than validation allows (300 characters and 10 suggestions, against
 * `MAX_SUGGESTION_TEXT` and `MAX_SUGGESTIONS`), so a model that runs a little over isn't dropped.
 */
export const SUGGESTION_SYSTEM_PROMPT = `You review how a strength-training log was grouped into macrocycles (runs of a program) before it is imported. Rules already grouped it from the dates: a break of more than 14 days suggests a new macrocycle, a run that finished every workout ends, and the program comes from the lifts. Your suggestions are optional: the lifter accepts or dismisses each one, and the grouping is complete without them.

The user message is JSON:
- importDate: today, YYYY-MM-DD.
- exportedFile: true when the file is this app's own export, whose groupings can't be moved.
- programs: the programs a macrocycle can belong to, with workouts per run (null: open-ended) and weeks per run. Ids like custom-program-1 stand for the lifter's own programs.
- stretches: the rules' macrocycles in date order: start and end dates, program id, whether every lift fits that program (matched), suggested status (null: the lifter must choose), why it starts where it does, and workout counts.
- flags: lone (a single-lift workout inside a break, which the lifter files), unnumbered (a workout with no macrocycle number in a numbered file), and conflicts between the file's numbers and its dates.
- sessions: every workout in date order. A session has either sets (lift, set number, weight, reps, and notes if the lifter chose to share them) or, in a long file, topSets (each lift's heaviest set) instead. Lift names like custom-lift-1 stand for the lifter's own lifts.

Look for what the rules can't see, such as a deload or a light week that isn't a restart, a restart with no break, or a run that ended differently than its status says. Suggest nothing when the grouping looks right. Every date you give must be a session date from the input.

Reply with only a JSON object of this form, and nothing else:
{"suggestions": [ ... ]}
Each suggestion is one of:
- {"kind": "boundary", "action": "add", "date": "YYYY-MM-DD", "reason": "..."}: start a new macrocycle at this session, which is inside a stretch and not its first.
- {"kind": "boundary", "action": "remove", "date": "YYYY-MM-DD", "reason": "..."}: join the stretch starting on this date to the one before it.
- {"kind": "lone", "date": "YYYY-MM-DD", "choice": ${oneOf(SESSION_CHOICES)}, "reason": "..."}: file a lone or unnumbered session with the macrocycle before it, after it, as a workout outside any macrocycle, or leave it out.
- {"kind": "status", "stretchStart": "YYYY-MM-DD", "status": ${oneOf(STRETCH_STATUSES)}, "reason": "..."}: the status of the stretch starting on that date.
- {"kind": "program", "stretchStart": "YYYY-MM-DD", "program": "<program id>", "reason": "..."}: the program of the stretch starting on that date.
- {"kind": "note", "from": "YYYY-MM-DD" or null, "to": "YYYY-MM-DD" or null, "text": "..."}: an observation that changes nothing, such as a pattern that matches no program.
Any suggestion may add "lifts": [lift names exactly as given] when its reason is about particular lifts. Keep each reason or note under 300 characters, written to the lifter in plain words. Give at most 10 suggestions.`;

/** The response's JSON Schema, for a provider that can be held to one (Anthropic's tool input). */
export const SUGGESTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: SUGGESTION_KINDS },
          action: { type: 'string', enum: BOUNDARY_ACTIONS },
          date: { type: 'string' },
          choice: { type: 'string', enum: SESSION_CHOICES },
          stretchStart: { type: 'string' },
          status: { type: 'string', enum: STRETCH_STATUSES },
          program: { type: 'string' },
          from: { type: ['string', 'null'] },
          to: { type: ['string', 'null'] },
          text: { type: 'string' },
          reason: { type: 'string' },
          lifts: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind'],
      },
    },
  },
  required: ['suggestions'],
} as const;
