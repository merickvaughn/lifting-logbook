# Glossary — training-time vocabulary

Lifting vocabulary is overloaded: "cycle" alone names three different spans of time depending
on who is writing. This page fixes the terms the code, the API and the UI use, and maps each one
to the other meanings a contributor or lifter will meet in program write-ups and coaching
literature. The decision behind the names is [ADR-038](adr/ADR-038-training-time-vocabulary.md).

- **End users** see the same content in the app at `/glossary` (`apps/web/lib/glossary.ts`). Headings
  across the app link into it through `GlossaryLink`. Keep the two in step.
- **End-user terms** that are not about time structure (1RM, training max, AMRAP, PR, the Brzycki
  formula) are also defined in the [user guide](user-guide.md#glossary).
- **How each level is stored** (rows vs. derived per request) is in
  [domain-model.md §3](domain-model.md#3-the-training-structure-taxonomy).

---

## The hierarchy, largest to smallest

```
Program → Macrocycle → Mesocycle → Week (microcycle) → Workout → Lift slot → Set
```

| Term | In this repo | Conventional meaning | Typical length | Other / slang meanings |
|---|---|---|---|---|
| **Program** | A program id (`5-3-1`, `leangains`, a custom program) and its spec | The training plan as written | — | — |
| **Macrocycle** | One full run through a program. `macrocycleNum`, `macrocycle_dashboard`, routes `/macrocycle/<n>` (web) and `/programs/:program/macrocycles/...` (API). Training maxes are recalculated when the next macrocycle starts (`startNewMacrocycle` → `updateMaxes`), a path the web app cannot reach yet ([domain-model D9](domain-model.md)). | The longest planning unit in periodization: a season or year, often built toward a competition [1] | Months to a year | "Cycle" in Juggernaut ("one full cycle = 16 weeks") and Smolov ("13-week squat cycle"). Informally "a program run" or "a run" [*] |
| **Mesocycle** | The repeating unit of weeks a stored spec holds, tiled to the macrocycle's length. `mesocycleWeeks` (`ProgramLengthMeta`), `mesocycleWeekForProgramWeek`, `phaseStyle: 'mesocycle'`. **"Block"** in UI labels (dashboard headings "Block 1 · Weeks 1–3"); "Mesocycle N" on the plan page. | A block of several microcycles with one training emphasis (accumulation, intensification, realization) [1][2] | About 3–6 weeks | Wendler's 5/3/1 **"cycle"**: three work weeks plus a deload, 4 weeks [3]. Juggernaut's **"wave"**. "Block" in block periodization [2] |
| **Microcycle** | A training week: `week`, `WeekType` (`training` \| `test` \| `deload`). UI says "Week N". | The shortest repeating training pattern, usually a week [1] | ~1 week | Some coaches build non-7-day microcycles (e.g. a 9-day rotation) |
| **Workout** | One training day. Keyed `(program, macrocycleNum, workoutNum)`. `workoutNum` is a global ordinal over the macrocycle; a schedule only dates it ([ADR-037](adr/ADR-037-schedule-dates-program-days.md)). | A training session | One day | "Session". The timer's "session queue" |
| **Lift slot** | A spec row keyed `(week, offset, lift, order)` | — | — | — |
| **Set** | `PlannedSet` (prescribed) / `LiftRecord` (logged) | — | — | — |

### Worked mappings

| Program | As its author describes it | As this app models it |
|---|---|---|
| **5/3/1** (Wendler) | 4-week "cycles": a 5s week, a 3s week, a 5/3/1 week and a deload. Training max +5 lb upper / +10 lb lower after each cycle [3] | One **12-week macrocycle** of four **3-week mesocycles** (`PROGRAM_LENGTHS['5-3-1']`). No deload week is scheduled (a v1.0 non-goal, see [PRD.md](PRD.md)). Training maxes update when the next macrocycle starts (not yet reachable from the web app, D9). |
| **Leangains** | Open-ended reverse-pyramid training | One **12-week macrocycle** of **1-week mesocycles** (`phaseStyle: 'repeating'`). The plan shows one "Training" span, and the dashboard shows no block headings. |
| **RPT** | Open-ended reverse-pyramid training | One **8-week macrocycle** of 1-week mesocycles, as Leangains. |
| **Juggernaut** (catalog copy only) | Four 4-week "waves" (10s, 8s, 5s, 3s); "one full cycle = 16 weeks" | Would be one 16-week macrocycle of four 4-week mesocycles. |

---

## Overloaded terms

| Word | Meanings you will meet | What this repo says instead |
|---|---|---|
| **Cycle** | (1) One block of a program, e.g. 5/3/1's 4 weeks [3]. (2) A whole program run, e.g. a Juggernaut or Smolov cycle. (3) The verb: cycle through exercises. | **Mesocycle** for (1), **macrocycle** for (2). The bare word is avoided in identifiers and labels. Program catalog copy quotes it in its author's sense. |
| **Wave** | (1) A block repeated across weeks (Juggernaut's 10s/8s/5s/3s waves; the 5/3/1 three-week wave). (2) "Wave loading": sets climb, drop back and climb again within one session. | **Mesocycle** for (1). (2) is not modeled. |
| **Block** | A mesocycle. "Block periodization" sequences short blocks that each train one quality [2]. | Used as the UI label for a mesocycle. |
| **Phase** | A goal-defined stretch (hypertrophy, strength, peaking): one mesocycle or several. Bompa also uses phase for the preparatory/competitive/transition parts of a macrocycle [1]. | The plan page heads its list "Mesocycles" for mesocycle programs and "Phases" for repeating ones. |
| **Session** | A workout. | **Workout**, except the timer's "session queue". |
| **Program run** | One time through a program. | **Macrocycle** (shown as an alias in the in-app glossary). |

---

## References

1. Bompa, T. O., & Buzzichelli, C. (2018). *Periodization: Theory and Methodology of Training*
   (6th ed.). Human Kinetics. ISBN 978-1-4925-4480-7. The macrocycle / mesocycle / microcycle
   hierarchy and the phases of the annual plan.
2. Issurin, V. B. (2010). New horizons for the methodology and physiology of training
   periodization. *Sports Medicine*, 40(3), 189–206.
   [doi:10.2165/11319770-000000000-00000](https://doi.org/10.2165/11319770-000000000-00000).
   Block periodization and the accumulation / transmutation / realization mesocycle types.
3. Wendler, J. (2011). *5/3/1: The Simplest and Most Effective Training System for Raw Strength*
   (2nd ed.). Jim Wendler LLC. The 4-week cycle, its deload week, and the training-max increments.

[*] "Program run" is observed community usage, not a term with an authoritative source.
