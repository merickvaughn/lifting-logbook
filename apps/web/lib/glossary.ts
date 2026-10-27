/**
 * The in-app glossary (`/glossary`): one source for the page and for every
 * {@link GlossaryLink} that points into it. Each term's `id` is its anchor on the
 * page, and {@link GlossaryTermId} is derived from this data, so a link to a term
 * that does not exist fails to compile.
 *
 * Lifting vocabulary is overloaded — "cycle" alone means three different spans of
 * time depending on who is talking — so terms carry their other common meanings
 * alongside the one this app uses. The developer-facing version, with sources,
 * is `docs/glossary.md`; keep the two in step.
 */

import { FOCUS_AREAS } from '@lifting-logbook/types';

export interface GlossaryTerm {
  /** Anchor id on the glossary page; `GlossaryLink` targets it. */
  readonly id: string;
  readonly term: string;
  /** Other names for the same thing, as this app uses it. */
  readonly aka?: readonly string[];
  readonly definition: string;
  /** What the word means elsewhere — other programs, coaches, sport science. */
  readonly otherMeanings?: readonly string[];
}

export interface GlossarySection {
  readonly id: string;
  readonly title: string;
  readonly intro?: string;
  readonly terms: readonly GlossaryTerm[];
}

export const GLOSSARY = [
  {
    id: 'time-structure',
    title: 'How training time is organized',
    intro:
      'From largest to smallest: a macrocycle is made of mesocycles, a mesocycle is made of weeks (microcycles), and a week is made of workouts.',
    terms: [
      {
        id: 'macrocycle',
        term: 'Macrocycle',
        aka: ['Program run'],
        definition:
          'One complete run through a program, start to finish — 12 weeks for 5/3/1 here. The dashboard shows your current macrocycle. Starting the next one, which will recalculate your training maxes from the sets you logged, is not available in the app yet.',
        otherMeanings: [
          'In sport science a macrocycle is usually a whole season or year of training, often built toward a competition.',
          'Lifters often say "cycle" for this, but just as often for a much shorter block — see Cycle below.',
        ],
      },
      {
        id: 'mesocycle',
        term: 'Mesocycle',
        aka: ['Block'],
        definition:
          'A block of weeks that repeats as a unit inside a macrocycle. 5/3/1 here uses 3-week mesocycles — a 5s week, a 3s week and a 5/3/1 week — four of them per macrocycle. Leangains and RPT repeat a single week, so they have no separate blocks.',
        otherMeanings: [
          'In sport science a mesocycle is usually 3–6 weeks aimed at one goal, such as building volume or peaking.',
          'Jim Wendler calls the 5/3/1 block a "cycle" (four weeks, counting a deload week). Juggernaut calls its blocks "waves".',
        ],
      },
      {
        id: 'microcycle',
        term: 'Microcycle',
        aka: ['Week'],
        definition:
          'The smallest repeating pattern of workouts — in this app, one training week. The dashboard lists them as Week 1, Week 2 and so on.',
        otherMeanings: [
          'Some coaches build microcycles that are not seven days long, such as a 9-day rotation.',
        ],
      },
      {
        id: 'workout',
        term: 'Workout',
        aka: ['Session'],
        definition:
          'One training day\'s lifts. Workouts are numbered in order across the macrocycle (Workout 1, Workout 2, …). Your schedule only decides which calendar day each one lands on.',
      },
      {
        id: 'deload',
        term: 'Deload',
        definition:
          'A planned lighter week to recover from accumulated fatigue. None of the built-in programs in this app schedules one yet.',
        otherMeanings: [
          'The original 5/3/1 makes every fourth week a deload. Many programs deload every 4–6 weeks.',
        ],
      },
      {
        id: 'test-week',
        term: 'Test week',
        definition:
          'A week of heavy sets used to find your training maxes, offered when you set up the app.',
      },
    ],
  },
  {
    id: 'programming',
    title: 'Weights and sets',
    terms: [
      {
        id: 'lift',
        term: 'Lift',
        definition:
          'A named movement you train and log, such as Back Squat, Bench Press or Face Pull, either built in or one you create. Every movement is a lift here, accessories included.',
        otherMeanings: [
          'Other apps and most training writing call it an exercise; the two words mean the same thing.',
          'In powerlifting, "the lifts" means only the squat, bench press and deadlift.',
        ],
      },
      {
        id: 'training-max',
        term: 'Training max',
        aka: ['TM'],
        definition:
          'The working number every percentage in your program is calculated from — typically 85–90% of your one-rep max, so it sits below your true max by design.',
      },
      {
        id: 'one-rep-max',
        term: 'One-rep max',
        aka: ['1RM'],
        definition:
          'The heaviest weight you can manage for a single rep of a given lift. Setup can estimate it from a heavier set of several reps using the Brzycki formula.',
      },
      {
        id: 'amrap',
        term: 'AMRAP',
        definition:
          '"As many reps as possible." The last set of some lifts is taken to technical failure, and the reps you hit drive your training-max changes.',
      },
      {
        id: 'personal-record',
        term: 'Personal record',
        aka: ['PR'],
        definition: 'Your best logged result for a lift — the heaviest weight, the most reps, or the highest training max.',
      },
      {
        id: 'brzycki-formula',
        term: 'Brzycki formula',
        definition:
          'One-rep max ≈ weight × 36 ÷ (37 − reps). Reasonably accurate for sets of 1–10 reps.',
      },
      {
        id: 'bodyweight-component',
        term: 'Bodyweight component',
        definition:
          'A lift where your body weight is part of the load, such as chin-ups or dips. Logging a workout with one asks for your current body weight.',
      },
    ],
  },
  {
    id: 'other-meanings',
    title: 'Words you will see used differently',
    intro:
      'Program write-ups, coaches and forums use these words loosely. Here is what each can mean, and what this app calls it.',
    terms: [
      {
        id: 'cycle',
        term: 'Cycle',
        definition:
          'This app avoids the bare word because it has at least three meanings. It says macrocycle for a whole program run and mesocycle for a block.',
        otherMeanings: [
          'One block of a program: in 5/3/1, three work weeks plus a deload, about four weeks. This is a mesocycle here.',
          'A whole program run, as in "a 13-week Smolov cycle" or "one 16-week Juggernaut cycle". This is a macrocycle here.',
          'A verb: to cycle through exercises or rotate variations.',
        ],
      },
      {
        id: 'wave',
        term: 'Wave',
        definition: 'Usually a block of weeks — a mesocycle in this app.',
        otherMeanings: [
          'A loading pattern repeated across weeks, like Juggernaut\'s 10s, 8s, 5s and 3s waves.',
          '"Wave loading" within a single workout: the weight climbs over a few sets, drops back, and climbs again.',
        ],
      },
      {
        id: 'block',
        term: 'Block',
        definition: 'The same thing as a mesocycle. The dashboard groups weeks into blocks.',
        otherMeanings: [
          '"Block periodization" strings together short blocks that each train one quality, such as volume, then intensity, then peaking.',
        ],
      },
      {
        id: 'focus-block',
        term: 'Focus block',
        definition: `Extra accessory work for one muscle area — ${FOCUS_AREAS.slice(0, -1).join(', ')} or ${FOCUS_AREAS[FOCUS_AREAS.length - 1]} — over a calendar month or quarter, added to every workout on a timeline separate from your program. Set them up under Programs → Focus work.`,
        otherMeanings: [
          'Not a block in the mesocycle sense above. This app always says "focus block" in full, never just "block".',
        ],
      },
      {
        id: 'phase',
        term: 'Phase',
        definition:
          'A stretch of training defined by its goal, such as a hypertrophy phase or a peaking phase. A phase can be one mesocycle or several. The Macrocycle Plan lists "Phases" in place of mesocycles for programs that repeat a single week.',
      },
    ],
  },
] as const satisfies readonly GlossarySection[];

export type GlossaryTermId = (typeof GLOSSARY)[number]['terms'][number]['id'];

/** Every glossary term, flattened, for lookups by id. */
export const GLOSSARY_TERMS: readonly GlossaryTerm[] = GLOSSARY.flatMap(
  (s): readonly GlossaryTerm[] => s.terms,
);

export function glossaryTerm(id: GlossaryTermId): GlossaryTerm {
  const term = GLOSSARY_TERMS.find((t) => t.id === id);
  // GlossaryTermId is derived from GLOSSARY, so every id resolves.
  if (!term) throw new Error(`Unknown glossary term: ${id}`);
  return term;
}
