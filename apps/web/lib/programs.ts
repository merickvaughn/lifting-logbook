import { LiftingProgramSpec, PRESET_BASE_SPECS, PROGRAM_LENGTHS } from '@lifting-logbook/core';
import type { CustomProgramSpecRow } from '@lifting-logbook/types';

export type Experience = 'beginner' | 'intermediate' | 'advanced';
export type Goal = 'strength' | 'muscle-gain' | 'body-composition' | 'fat-loss';
export type Purpose =
  | 'Strength'
  | 'Hypertrophy'
  | 'Bodybuilding'
  | 'Powerlifting'
  | 'Sports'
  | 'Beginner'
  | 'Intermediate';

export type Program = {
  id: string;
  name: string;
  experience: Experience;
  meta: string;
  description: string;
  weeks: number;
  daysPerWeek: number;
  progression: string;
  deloads: string;
  periodization: string;
  purposes: Purpose[];
  goals: Goal[];
  lifts: string[];
  schedule: { day: string; lifts: string[] }[];
  available: boolean;
};

export const SEED_PROGRAM = '5-3-1';
export const SEED_LEANGAINS = 'leangains';

export function seedProgramSpec(): LiftingProgramSpec[] {
  return PRESET_BASE_SPECS['5-3-1']?.slice() ?? [];
}

export function seedLeangainsSpec(): LiftingProgramSpec[] {
  return PRESET_BASE_SPECS['leangains']?.slice() ?? [];
}

export const TEMPLATE_BUILDERS: Record<string, () => LiftingProgramSpec[]> = {
  [SEED_PROGRAM]: seedProgramSpec,
  [SEED_LEANGAINS]: seedLeangainsSpec,
};

/**
 * Full spec for a clone template, as CustomProgramSpecRow[], expanded across the
 * editor's three weeks. Unlike the editor's older per-lift seeding, this is NOT
 * filtered to a selected-lift set — it returns the template's entire workout-day
 * structure (all offsets) so the editor can pre-populate days and instances when
 * cloning (issue #751). Single-week templates (maxWeek === 1) are tiled across
 * weeks 1/2/3. Returns [] for templates with no registered builder.
 */
export function templateSeedSpecs(templateId: string): CustomProgramSpecRow[] {
  const builder = TEMPLATE_BUILDERS[templateId];
  const seeded = builder ? builder() : null;
  if (!seeded || seeded.length === 0) return [];

  const maxWeek = Math.max(...seeded.map((s) => s.week));
  const expanded =
    maxWeek === 1
      ? [1, 2, 3].flatMap((w) => seeded.map((s) => ({ ...s, week: w })))
      : seeded;

  return expanded.map((s) => ({
    week: s.week,
    offset: s.offset,
    lift: s.lift as string,
    increment: s.increment,
    order: s.order,
    sets: s.sets,
    reps: s.reps,
    amrap: Boolean(s.amrap),
    warmUpPct: s.warmUpPct,
    wtDecrementPct: s.wtDecrementPct,
    activation: s.activation,
    ...(s.weekType !== undefined ? { weekType: s.weekType as string } : {}),
  }));
}

// Base program catalog. `weeks` for programs wired to a core preset is reconciled
// below from the canonical PROGRAM_LENGTHS registry, so onboarding copy can never
// drift from the length the API actually schedules (issue #680). Unregistered
// (marketing-only) programs keep their catalog literal.
const PROGRAM_CATALOG: Program[] = [
  {
    id: 'starting-strength',
    name: 'Starting Strength',
    experience: 'beginner',
    meta: '3 days/week · Linear progression',
    description:
      'Mark Rippetoe’s linear progression program. Squat, press, deadlift, bench, and power clean — add weight every session until stalls require a deload.',
    weeks: 12,
    daysPerWeek: 3,
    progression:
      'Add 5 lb to squat and deadlift and 2.5 lb to upper-body lifts after every session. When you miss a rep target three sessions in a row, deload 10% and reset.',
    deloads:
      'Deload 10% on a stalling lift and return to linear progression. Deloads are reactive — triggered by stall, not scheduled.',
    periodization:
      'Single linear phase that continues until progress stalls on all major lifts, typically 3–6 months for true beginners.',
    purposes: ['Strength', 'Beginner'],
    goals: ['strength'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Power Clean'],
    schedule: [
      { day: 'Monday (A)', lifts: ['Squat 3×5', 'Bench Press 3×5', 'Deadlift 1×5'] },
      { day: 'Wednesday (B)', lifts: ['Squat 3×5', 'Overhead Press 3×5', 'Deadlift 1×5'] },
      { day: 'Friday (A)', lifts: ['Squat 3×5', 'Bench Press 3×5', 'Deadlift 1×5'] },
    ],
    available: false,
  },
  {
    id: 'stronglifts',
    name: 'StrongLifts 5×5',
    experience: 'beginner',
    meta: '3 days/week · 5×5 alternating workouts',
    description:
      'Two alternating workouts (A/B) with five compound lifts at 5 sets of 5 reps. Add 5 lb every session until plateau.',
    weeks: 12,
    daysPerWeek: 3,
    progression:
      'Add 5 lb to lower-body and 2.5 lb to upper-body lifts after every successful 5×5. Deload 10% after three consecutive failures on a lift.',
    deloads:
      'Three missed sessions triggers a 10% deload on the stalling lift. After two deloads, switch to 3×5 instead of 5×5.',
    periodization:
      'Continuous linear phase until multiple lifts stall simultaneously, typically 3–5 months before intermediate programming is needed.',
    purposes: ['Strength', 'Beginner'],
    goals: ['strength'],
    lifts: ['Squat', 'Bench Press', 'Barbell Row', 'Overhead Press', 'Deadlift'],
    schedule: [
      { day: 'Monday (A)', lifts: ['Squat 5×5', 'Bench Press 5×5', 'Barbell Row 5×5'] },
      { day: 'Wednesday (B)', lifts: ['Squat 5×5', 'Overhead Press 5×5', 'Deadlift 1×5'] },
      { day: 'Friday (A)', lifts: ['Squat 5×5', 'Bench Press 5×5', 'Barbell Row 5×5'] },
    ],
    available: false,
  },
  {
    id: 'rpt',
    name: 'Reverse Pyramid Training (Lyle/Eric Helms)',
    experience: 'intermediate',
    meta: '3-4 days/week · Top-set focused',
    description:
      'Heaviest set first, then back-off sets at reduced load. Emphasizes intensity on the first work set with clear progression rules tied to top-set rep targets.',
    weeks: 8,
    daysPerWeek: 3,
    progression:
      'Hit the top-set rep ceiling (e.g. 6 reps), add 2.5–5 lb next session. Miss the floor (e.g. 4 reps), stay at the same weight. Back-off sets drop 10% from the top-set load.',
    deloads:
      'Deload every 8–12 weeks or when performance degrades across two consecutive sessions. Drop to 60% of top-set load for all sets, full ROM focus.',
    periodization:
      'Runs in open-ended blocks; most lifters deload every 2–3 months and reset top-set targets after a deload.',
    purposes: ['Strength', 'Hypertrophy'],
    goals: ['strength', 'muscle-gain'],
    lifts: ['Bench Press', 'Squat', 'Deadlift', 'Overhead Press', 'Barbell Row'],
    schedule: [
      { day: 'Monday', lifts: ['Bench Press RPT', 'Barbell Row RPT', 'Overhead Press RPT'] },
      { day: 'Wednesday', lifts: ['Squat RPT', 'Romanian Deadlift RPT', 'Calf Raises'] },
      { day: 'Friday', lifts: ['Deadlift RPT', 'Weighted Pull-ups RPT', 'Dips RPT'] },
    ],
    available: true,
  },
  {
    id: 'ppl',
    name: 'Push / Pull / Legs',
    experience: 'intermediate',
    meta: '6 days/week · Hypertrophy split',
    description:
      'Classic split that lets you train each major movement pattern twice per week. Volume scales with recovery; popular as PHUL/PHAT variants too.',
    weeks: 12,
    daysPerWeek: 6,
    progression:
      'Double progression: hit the top of the rep range for all sets, then add 2.5–5 lb next session. Most exercises use 3–4 sets of 8–12 reps.',
    deloads:
      'Schedule a light week (50% volume) every 8–10 weeks, or when fatigue prevents hitting rep targets on two consecutive sessions.',
    periodization:
      'Runs in open-ended blocks separated by deload weeks. Volume can be periodized: accumulation (high volume) → intensification (lower reps, higher load).',
    purposes: ['Hypertrophy', 'Bodybuilding'],
    goals: ['muscle-gain', 'body-composition'],
    lifts: ['Bench Press', 'Overhead Press', 'Squat', 'Deadlift', 'Pull-ups', 'Rows'],
    schedule: [
      { day: 'Monday (Push)', lifts: ['Bench Press', 'Incline DB Press', 'Lateral Raises', 'Tricep Pushdowns'] },
      { day: 'Tuesday (Pull)', lifts: ['Deadlift', 'Pull-ups', 'Barbell Row', 'Face Pulls', 'Bicep Curls'] },
      { day: 'Wednesday (Legs)', lifts: ['Squat', 'Leg Press', 'Leg Curl', 'Calf Raises'] },
      { day: 'Thursday (Push)', lifts: ['Overhead Press', 'DB Shoulder Press', 'Cable Flyes', 'Skull Crushers'] },
      { day: 'Friday (Pull)', lifts: ['Pull-ups', 'Seated Cable Row', 'DB Row', 'Reverse Flyes'] },
      { day: 'Saturday (Legs)', lifts: ['Romanian Deadlift', 'Hack Squat', 'Leg Extension', 'Calf Raises'] },
    ],
    available: false,
  },
  {
    id: 'upper-lower',
    name: 'Upper / Lower',
    experience: 'intermediate',
    meta: '4 days/week · Balanced split',
    description:
      'Upper body and lower body alternated four days per week. Good middle ground between full-body frequency and bodypart split volume.',
    weeks: 8,
    daysPerWeek: 4,
    progression:
      'Linear progression on main compound lifts (add weight each week). Accessory work uses double progression (reps, then load).',
    deloads:
      'Deload every 6–8 weeks. Cut volume by 40–50% while maintaining intensity; focus on technique and recovery.',
    periodization:
      'Typically run in 4–8 week blocks with distinct strength (lower reps) and hypertrophy (higher reps) phases.',
    purposes: ['Strength', 'Hypertrophy'],
    goals: ['strength', 'muscle-gain'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Pull-ups', 'Rows'],
    schedule: [
      { day: 'Monday (Upper — Strength)', lifts: ['Bench Press 4×5', 'Barbell Row 4×5', 'Overhead Press 3×8'] },
      { day: 'Tuesday (Lower — Strength)', lifts: ['Squat 4×5', 'Romanian Deadlift 3×8', 'Leg Curl 3×10'] },
      { day: 'Thursday (Upper — Hypertrophy)', lifts: ['Incline DB Press 4×10', 'Cable Row 4×10', 'Lateral Raises 3×15'] },
      { day: 'Friday (Lower — Hypertrophy)', lifts: ['Deadlift 3×5', 'Leg Press 4×10', 'Leg Extension 3×12'] },
    ],
    available: false,
  },
  {
    id: '531',
    name: '5/3/1',
    experience: 'intermediate',
    meta: '4 days/week · Wave-loaded',
    description:
      'Jim Wendler’s program of 4-week “cycles” — three work weeks and a deload — with a top set on each main lift, then assistance work. Conservative training maxes (90% of 1RM) drive long-term progress.',
    weeks: 16,
    daysPerWeek: 4,
    progression:
      'Wendler raises the training max by 5 lb for upper-body and 10 lb for lower-body lifts after each 4-week cycle. Each week uses percentages of the training max: 65/75/85% → 70/80/90% → 75/85/95% → deload. This app runs the three work weeks as a 3-week mesocycle, four times per 12-week macrocycle. Starting the next macrocycle, which recalculates training maxes from your logged sets, is not available in the app yet.',
    deloads:
      'In the original program, week 4 of every cycle is a planned deload at 40/50/60% of training max. This app does not schedule the deload week yet.',
    periodization:
      'Wendler’s 4-week cycles repeat indefinitely; most lifters run a main template for 6–12 months before needing a major reset. In this app one macrocycle is 12 weeks: four 3-week mesocycles.',
    purposes: ['Strength'],
    goals: ['strength'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press'],
    schedule: [
      { day: 'Monday', lifts: ['Overhead Press (5/3/1)', 'Bench Press assistance', 'Row assistance'] },
      { day: 'Tuesday', lifts: ['Deadlift (5/3/1)', 'Squat assistance', 'Core work'] },
      { day: 'Thursday', lifts: ['Bench Press (5/3/1)', 'Overhead Press assistance', 'Row assistance'] },
      { day: 'Friday', lifts: ['Squat (5/3/1)', 'Deadlift assistance', 'Core work'] },
    ],
    available: false,
  },
  {
    id: '531-bbb',
    name: '5/3/1 Boring But Big',
    experience: 'intermediate',
    meta: '4 days/week · BBB volume template',
    description:
      'Standard 5/3/1 main work followed by 5×10 of the same lift (or its complement) at 50–70% TM. High-volume hypertrophy template most lifters can recover from.',
    weeks: 16,
    daysPerWeek: 4,
    progression:
      'Same 5/3/1 wave structure as the base program. BBB sets use a fixed percentage (50–70% TM) that can increase each 4-week cycle as strength improves.',
    deloads:
      'Week 4 planned deload covers the main sets. BBB sets drop to 5×5 at 50% TM during the deload week.',
    periodization:
      'Typically run for 2–3 of Wendler’s 4-week cycles (8–12 weeks) before switching to an intensity-focused template like FSL or SSL, then returning to BBB.',
    purposes: ['Strength', 'Hypertrophy'],
    goals: ['strength', 'muscle-gain'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press'],
    schedule: [
      { day: 'Monday', lifts: ['Overhead Press (5/3/1)', 'Bench Press 5×10 @ 50% TM', 'Rows'] },
      { day: 'Tuesday', lifts: ['Deadlift (5/3/1)', 'Squat 5×10 @ 50% TM', 'Core'] },
      { day: 'Thursday', lifts: ['Bench Press (5/3/1)', 'Overhead Press 5×10 @ 50% TM', 'Rows'] },
      { day: 'Friday', lifts: ['Squat (5/3/1)', 'Deadlift 5×10 @ 50% TM', 'Core'] },
    ],
    available: false,
  },
  {
    id: '531-forever',
    name: '5/3/1 Forever',
    experience: 'advanced',
    meta: '3-5 days/week · Multi-cycle leader/anchor',
    description:
      'The latest evolution of 5/3/1 organized into “leader” volume blocks and “anchor” intensity blocks. Drops the deload week in favor of programmed light days.',
    weeks: 24,
    daysPerWeek: 4,
    progression:
      '“Leader” cycles (2–3 per anchor) run at high volume and moderate intensity. “Anchor” cycles dial up intensity with PR sets. Training max increases after the full leader/anchor sequence.',
    deloads:
      'No dedicated deload week — light days and the reduced intensity of leader weeks serve as active recovery. A full rest week after each anchor cycle is optional.',
    periodization:
      'Long-term structure: 2 leader cycles + 1 anchor cycle = one sequence (roughly 12 weeks). Training max is tested and reset after each sequence.',
    purposes: ['Strength'],
    goals: ['strength'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press'],
    schedule: [
      { day: 'Monday', lifts: ['Squat — Leader or Anchor sets', 'Squat supplemental', 'Pulling accessory'] },
      { day: 'Tuesday', lifts: ['Bench Press — Leader or Anchor sets', 'Bench supplemental', 'Row accessory'] },
      { day: 'Thursday', lifts: ['Deadlift — Leader or Anchor sets', 'Deadlift supplemental', 'Core'] },
      { day: 'Friday', lifts: ['Overhead Press — Leader or Anchor sets', 'OHP supplemental', 'Row accessory'] },
    ],
    available: false,
  },
  {
    id: 'leangains',
    name: 'Leangains (Berkhan)',
    experience: 'intermediate',
    meta: '3 days/week · RPT + IF protocol',
    description:
      'Reverse-pyramid lifting paired with intermittent fasting. Three compound-focused sessions per week with macros tuned to training and rest days.',
    weeks: 12,
    daysPerWeek: 3,
    progression:
      'RPT rules: hit the top-set rep ceiling, add 2.5–5 lb next session. Stalled for 2 sessions? Deload 10% on that lift and reset.',
    deloads:
      'Reactive: deload after two consecutive stalls or when overall fatigue accumulates. Drop all working weights 10–15% and rebuild.',
    periodization:
      'Runs in open-ended blocks. Most practitioners alternate muscle-gain and fat-loss phases of 8–12 weeks, adjusting caloric intake to match.',
    purposes: ['Strength', 'Hypertrophy'],
    goals: ['strength', 'muscle-gain', 'fat-loss', 'body-composition'],
    lifts: ['Bench Press', 'Weighted Pull-ups', 'Squat', 'Deadlift', 'Overhead Press'],
    schedule: [
      { day: 'Monday (Chest/Back)', lifts: ['Bench Press RPT', 'Weighted Pull-ups RPT', 'Incline DB Press 3×8', 'Cable Row 3×10'] },
      { day: 'Wednesday (Legs)', lifts: ['Squat RPT', 'Romanian Deadlift 3×8', 'Leg Curl 3×10', 'Calf Raises 4×12'] },
      { day: 'Friday (Shoulders/Arms)', lifts: ['Overhead Press RPT', 'Deadlift 1×5', 'Lateral Raises 4×12', 'Dips 3×8'] },
    ],
    available: true,
  },
  {
    id: 'conjugate',
    name: 'Westside Conjugate',
    experience: 'advanced',
    meta: '4 days/week · Max effort + dynamic effort',
    description:
      'Westside Barbell’s max-effort and dynamic-effort waves rotated across upper and lower days. Heavy emphasis on accommodating resistance and weak-point training.',
    weeks: 12,
    daysPerWeek: 4,
    progression:
      'Max-effort days: work up to a 1–3RM on a main movement, rotate the exercise every 1–3 weeks to avoid CNS adaptation. Dynamic-effort days: 8–12 sets of 2 at 50–60% with added bands or chains.',
    deloads:
      'Deload after 3 weeks of max-effort work: reduce to 70% of recent max-effort weight, cut dynamic sets to 6×2. Full deload week optional every 8–12 weeks.',
    periodization:
      'Three-week pendulum wave on dynamic-effort percentages (50% → 55% → 60%), then reset. Max-effort movement rotation is separate and ongoing.',
    purposes: ['Strength', 'Powerlifting'],
    goals: ['strength'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Box Squat', 'Variations'],
    schedule: [
      { day: 'Sunday (Max Effort Lower)', lifts: ['ME Squat/Deadlift variation', 'Accessory: hamstrings', 'Accessory: abs/lower back'] },
      { day: 'Monday (Max Effort Upper)', lifts: ['ME Bench variation', 'Accessory: triceps', 'Accessory: lats/upper back'] },
      { day: 'Wednesday (Dynamic Effort Lower)', lifts: ['DE Box Squat 8–12×2 w/ bands', 'Speed Deadlift 6–8×1', 'Accessory: glutes/hamstrings'] },
      { day: 'Friday (Dynamic Effort Upper)', lifts: ['DE Bench 8–10×3 w/ bands', 'Accessory: shoulders/triceps', 'Accessory: lats'] },
    ],
    available: false,
  },
  {
    id: 'smolov',
    name: 'Smolov (Squat)',
    experience: 'advanced',
    meta: '4 days/week · 13-week squat cycle',
    description:
      'Soviet squat specialization program. Brutal intro phase, base mesocycle, switching, and intense mesocycle. Use only with deep recovery support.',
    weeks: 13,
    daysPerWeek: 4,
    progression:
      'Prescribed percentages of your current 1RM. Base mesocycle: 4 sessions/week at increasing volume. Intense mesocycle: load increases 10–15 lb per week across 4 sessions.',
    deloads:
      'Switching phase (weeks 8–9) acts as a transition deload: reduced squatting volume, bench and other lifts, active recovery. No mid-cycle deloads — the program runs as written.',
    periodization:
      'Run once (13 weeks), take 1–2 weeks full rest, test a new 1RM. Most lifters run it only once per year due to the systemic stress.',
    purposes: ['Strength', 'Sports'],
    goals: ['strength'],
    lifts: ['Squat'],
    schedule: [
      { day: 'Monday', lifts: ['Squat — prescribed sets/reps at % 1RM'] },
      { day: 'Wednesday', lifts: ['Squat — prescribed sets/reps at % 1RM'] },
      { day: 'Friday', lifts: ['Squat — prescribed sets/reps at % 1RM'] },
      { day: 'Saturday', lifts: ['Squat — prescribed sets/reps at % 1RM'] },
    ],
    available: false,
  },
  {
    id: 'juggernaut',
    name: 'Juggernaut Method',
    experience: 'advanced',
    meta: '4 days/week · Block periodization',
    description:
      'Chad Wesley Smith’s block model with accumulation, intensification, and realization phases. Long-term progression with built-in volume waves.',
    weeks: 16,
    daysPerWeek: 4,
    progression:
      'Four waves across 4 months: 10s wave (accumulation), 8s wave, 5s wave, 3s wave (realization). Load increases each week within a wave; AMRAP sets guide progression.',
    deloads:
      'After each 4-week wave, a transition week at 60% volume and intensity before the next wave begins. Serves as a built-in deload between blocks.',
    periodization:
      'One full “cycle” = 16 weeks (4 waves × 4 weeks) — a macrocycle of four mesocycles, in this app’s terms. After completing it, retest 1RMs and begin the next one with updated percentages.',
    purposes: ['Strength', 'Powerlifting'],
    goals: ['strength'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press'],
    schedule: [
      { day: 'Monday', lifts: ['Squat — wave sets + back-off', 'Leg press, leg curls'] },
      { day: 'Tuesday', lifts: ['Bench Press — wave sets + back-off', 'Row, shoulder accessory'] },
      { day: 'Thursday', lifts: ['Deadlift — wave sets + back-off', 'Squat accessory, hamstrings'] },
      { day: 'Friday', lifts: ['Overhead Press — wave sets + back-off', 'Bench accessory, arms'] },
    ],
    available: false,
  },
  {
    id: 'creeping-death-2',
    name: 'Creeping Death II',
    experience: 'advanced',
    meta: '4 days/week · 5/3/1 program of programs',
    description:
      'A long-haul 5/3/1 template that stretches each cycle’s pace and increases supplemental work over time. Built for advanced lifters chasing slow PRs.',
    weeks: 24,
    daysPerWeek: 4,
    progression:
      'Uses 5/3/1 percentages with extended cycles: each wave progresses more slowly than standard 5/3/1, giving the body more time to adapt to each load bracket.',
    deloads:
      'Built-in deload weeks occur every 6 weeks (longer than standard 5/3/1’s 4-week wave). Supplemental volume drops significantly during deload.',
    periodization:
      'Designed as a 6-month program with progressive supplemental work phases. After completion, lifters typically test maxes and return to a simpler 5/3/1 template.',
    purposes: ['Strength'],
    goals: ['strength'],
    lifts: ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press'],
    schedule: [
      { day: 'Monday', lifts: ['Squat (5/3/1 wave)', 'Supplemental: Squat 5×FSL', 'Posterior chain accessory'] },
      { day: 'Tuesday', lifts: ['Bench Press (5/3/1 wave)', 'Supplemental: OHP 5×FSL', 'Upper back, arms'] },
      { day: 'Thursday', lifts: ['Deadlift (5/3/1 wave)', 'Supplemental: Deadlift 5×FSL', 'Core, hamstrings'] },
      { day: 'Friday', lifts: ['Overhead Press (5/3/1 wave)', 'Supplemental: Bench 5×FSL', 'Row, arms'] },
    ],
    available: false,
  },
];

/**
 * Onboarding/browse program catalog. For programs registered in the canonical
 * core `PROGRAM_LENGTHS` (currently Leangains, RPT, 5-3-1), the advertised `weeks`
 * is derived from that single source of truth rather than a standalone literal —
 * see issue #680. Programs without a registry entry pass through unchanged.
 */
export const PROGRAMS: Program[] = PROGRAM_CATALOG.map((program) => {
  const canonical = PROGRAM_LENGTHS[program.id];
  return canonical ? { ...program, weeks: canonical.lengthWeeks } : program;
});
