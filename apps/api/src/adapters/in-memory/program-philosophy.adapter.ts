import {
  IProgramPhilosophyRepository,
  ProgramPhilosophy,
} from '../../ports/IProgramPhilosophyRepository';

// How this app changes training maxes, shared by every program it schedules.
// Maxes are recalculated only when the next macrocycle starts (`updateMaxes`,
// reached from `macrocycle-generation.service.ts`), never within one.
const APP_MAX_UPDATES =
  'Training maxes are recalculated from logged sets only when the next macrocycle starts, using each lift’s `increment` from the program spec (get_program_spec). A training max you propose applies to every week of the next macrocycle.';

// Berkhan's reverse-pyramid rules, shared by the Leangains and RPT presets,
// which this app runs as the same 1-week block over different lengths.
const BERKHAN_RPT = {
  progressionRules:
    'As Berkhan wrote it: when the top set hits the upper rep target (e.g., 6 reps on a 4–6 set), add weight next session: ~2.5–5 lb upper-body, ~5–10 lb lower-body. Otherwise repeat.',
  trainingMaxGuidance:
    'No formal TM. Top set weight is the target; back-off weights are computed by % drop (typically 10% then 10% again).',
  deloadGuidance:
    'As Berkhan wrote it: no scheduled deload. Take 4–7 days off when consistently missing top-set rep targets.',
};

// The Leangains and RPT presets reverse-pyramid only some lifts.
const APP_RPT_SETS =
  'Only lifts with an AMRAP top set and a `wtDecrementPct` in the program spec run as a reverse pyramid; the rest, including accessory work, are straight sets.';

const PHILOSOPHIES: ProgramPhilosophy[] = [
  {
    programType: '5-3-1',
    displayName: "Wendler 5/3/1",
    summary:
      'As Wendler wrote it: a four-week strength cycle built around four main lifts (Squat, Bench, Deadlift, OHP). Each week prescribes three top sets at percentages of a Training Max, with the last set as an AMRAP. Slow, sustainable progress.',
    progressionRules:
      'As Wendler wrote it: after each cycle, add +5 lb to upper-body Training Maxes (Bench, OHP) and +10 lb to lower-body Training Maxes (Squat, Deadlift). If a target rep count is missed on an AMRAP, hold or reset.',
    trainingMaxGuidance:
      'Set Training Max at 90% of true 1RM. The TM is intentionally conservative to support multiple AMRAP reps and long-term progression. Reset to 90% of current TM when stalling on a lift twice.',
    deloadGuidance:
      'As Wendler wrote it: week 4 is a deload: 3 sets of 5 at 40/50/60% of TM. Do not skip — accumulated fatigue compounds across cycles.',
    notes: [
      'Prilepin-aligned set/rep volume.',
      'AMRAP reps on the top set are the primary indicator of true progress.',
      'Joker sets and First Set Last (FSL) are common optional supplemental work.',
    ],
    appModel:
      `This app runs 5/3/1 as one 12-week macrocycle of four 3-week mesocycles: the 5s, 3s and 5/3/1 weeks, repeated. No deload week is scheduled, so do not plan or recommend one. Training maxes do not rise between mesocycles. ${APP_MAX_UPDATES}`,
  },
  {
    programType: '5-3-1-bbb',
    displayName: '5/3/1 Boring But Big (BBB)',
    summary:
      'Wendler 5/3/1 main work plus 5×10 supplemental sets of the same lift at 50–60% of TM. High-volume hypertrophy template stacked on the strength base.',
    progressionRules:
      'Same as 5/3/1 for main work (+5 upper, +10 lower per cycle). Supplemental 5×10 percentage steps up gradually (50% → 60% → 70%) over multi-cycle blocks; back off if recovery suffers.',
    trainingMaxGuidance:
      'Same TM rules as 5/3/1: 90% of true 1RM, conservative; reset on second stall.',
    deloadGuidance:
      'Standard 5/3/1 deload week — drop the BBB volume entirely on deload weeks.',
    notes: [
      'High systemic fatigue — eat and sleep accordingly.',
      'Often run for 3 cycles then switched to a different supplemental template.',
    ],
  },
  {
    programType: '5-3-1-boring-but-strong',
    displayName: '5/3/1 Boring But Strong (BBS)',
    summary:
      '5/3/1 main work followed by 5×5 supplemental at 65–75% of TM. More strength-biased than BBB, less volume-driven.',
    progressionRules:
      'Same as 5/3/1 for main work. Supplemental 5×5 weight scales with TM, so it advances automatically.',
    trainingMaxGuidance: 'Same TM rules as 5/3/1.',
    deloadGuidance: 'Standard 5/3/1 deload.',
    notes: [
      'Better choice than BBB for lifters whose recovery is the limiter.',
    ],
  },
  {
    programType: 'starting-strength',
    displayName: 'Starting Strength',
    summary:
      'Linear-progression novice program by Mark Rippetoe. Three workouts per week alternating A/B with Squat every session, Bench/OHP and Deadlift/Power Clean rotating.',
    progressionRules:
      'Add weight every single workout: +5 lb upper-body, +5–10 lb lower-body, until you fail to complete prescribed reps. Then deload that lift by 10% and ramp back up.',
    trainingMaxGuidance:
      'No TM concept — the working weight IS the goal. The program assumes you are a true novice and gains are linear session-to-session.',
    deloadGuidance:
      'No scheduled deload. Deload only on a missed-reps stall: drop the failed lift 10% and rebuild.',
    notes: [
      "Designed for novices only. After 3–6 months most lifters need to graduate to a more structured intermediate program (Texas Method, 5/3/1).",
      'Form is non-negotiable; the program assumes coached technique.',
    ],
  },
  {
    programType: 'stronglifts-5x5',
    displayName: 'StrongLifts 5×5',
    summary:
      'Novice 5×5 program: Squat, Bench, Row on Workout A; Squat, OHP, Deadlift on Workout B. Three sessions per week, alternating.',
    progressionRules:
      'Add 5 lb to each lift every session (2.5 lb on OHP/Bench when stalling). On a failed session, repeat the weight; after 3 consecutive failures, deload that lift by 10%.',
    trainingMaxGuidance:
      'No TM concept. Working weight is the target.',
    deloadGuidance: 'Triggered by 3 consecutive failures, not scheduled.',
    notes: [
      'Squat-heavy: 15 work sets of squat per week is a lot of recovery demand.',
      'Graduate to Madcow or 5/3/1 once linear progression breaks down (typically 3–6 months in).',
    ],
  },
  {
    programType: 'leangains',
    displayName: 'Leangains — Reverse Pyramid Training (Berkhan)',
    summary:
      "As Berkhan wrote it: one all-out top set, then 1–2 back-off sets at reduced weight and higher reps, paired with intermittent fasting. Designed for lifters in a caloric deficit or maintenance, prioritizing strength retention with low volume.",
    ...BERKHAN_RPT,
    notes: [
      'Pairs with intermittent fasting (16:8) in the original Leangains framework.',
      'Very low volume — works well in a deficit, may underperform in a surplus vs. higher-volume programs.',
      'Compound lifts only; minimal accessory work.',
    ],
    appModel:
      `This app runs Leangains as one 12-week macrocycle of identical 1-week mesocycles. No deload is scheduled. Working weights do not rise session to session within the macrocycle. ${APP_RPT_SETS} ${APP_MAX_UPDATES}`,
  },
  {
    programType: 'rpt',
    displayName: 'Reverse Pyramid Training (RPT)',
    summary:
      "As Berkhan wrote it: one all-out top set, then 1–2 back-off sets at reduced weight and higher reps. Low volume, prioritizing strength on the heaviest set.",
    ...BERKHAN_RPT,
    notes: [
      'Very low volume — works well in a deficit, may underperform in a surplus vs. higher-volume programs.',
    ],
    appModel:
      `This app runs RPT as one 8-week macrocycle of identical 1-week mesocycles. No deload is scheduled. Working weights do not rise session to session within the macrocycle. ${APP_RPT_SETS} ${APP_MAX_UPDATES}`,
  },
];

export class InMemoryProgramPhilosophyRepository
  implements IProgramPhilosophyRepository
{
  private byType = new Map<string, ProgramPhilosophy>(
    PHILOSOPHIES.map((p) => [p.programType, p]),
  );

  async getProgramPhilosophy(
    programType: string,
  ): Promise<ProgramPhilosophy | null> {
    return this.byType.get(programType) ?? null;
  }

  async listPrograms(): Promise<ProgramPhilosophy[]> {
    return [...this.byType.values()];
  }
}
