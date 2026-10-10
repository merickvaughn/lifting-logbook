# Workout Scheduling Integration Design

**Status:** Design (not yet implemented)  
**Last Updated:** May 17, 2026  
**Scope:** Program editing with per-program workouts/week override and automatic workout date distribution

## Overview

This design document specifies how to integrate the workout scheduling feature into Lifting Logbook. The feature allows users to:

1. Define a preferred workout schedule (fixed days or rotating pattern) in settings
2. Override the prescribed workouts-per-week for any program independently
3. Automatically distribute cycle workouts across actual calendar dates respecting the user's schedule

### No-Schedule Mode

When no `workoutSchedule` is set in user settings, the system operates in **no-schedule mode**:
- No dates are assigned to pending/planned workouts
- The effective date of a workout is set to the date the user logs their first set for that workout
- This is the default state for new users and the fallback when a user explicitly declines to apply their schedule to a program

### Schedule Mode

When a `workoutSchedule` is set in user settings, the system can operate in **schedule mode** for a program. The schedule determines which days of the week workouts fall on; the program provides the sequence of workouts. The pace (workouts per week) is an emergent property of the schedule — not a separately configured value.

When a user sets a schedule or selects a program while a schedule is active, the system prompts:

> "Use your schedule (Mon/Wed/Fri) to distribute workout dates for this program?"

- **Yes** → schedule mode: dates are distributed using `distributeWorkouts()` and displayed in the cycle dashboard
- **No** → no-schedule mode: no dates are pre-assigned; date is set at logging time

A program does not store a "workouts per week" override — the schedule is the sole source of date distribution. Duration is derivable: `⌈cycleWorkouts / scheduleWorkoutsPerWeek⌉` weeks, shown as an informational estimate in the UI.

## Data Model

### User Settings Extension

Add to the user settings document/record:

```typescript
// packages/types/src/api.ts

export interface UserWorkoutSchedule {
  type: 'fixed' | 'rotating';
  /** For fixed schedules: array of day indices (0=Mon, 6=Sun) */
  days?: number[];
  /** For rotating schedules: array of week patterns, each containing day indices */
  weeks?: number[][];
}

export interface UserSettingsResponse {
  activeProgram: string | null;
  workoutSchedule?: UserWorkoutSchedule;
}
```

### Program Model

Programs do not store a workouts-per-week value. The schedule is the sole source of date distribution. `UpdateCycleOverrides` is not extended.

```typescript
// packages/types/src/api.ts

export interface CustomProgramResponse {
  id: string;
  name: string;
  description: string | null;
  baseTemplate: string | null;
  createdAt: string;
  specs: CustomProgramSpecRow[];
}

export interface UpdateCustomProgramRequest {
  name?: string;
  description?: string;
  specs?: CustomProgramSpecRow[];
}
```

## API Contracts

### GET /users/settings

**Response:**
```json
{
  "activeProgram": "5-3-1-custom",
  "workoutSchedule": {
    "type": "fixed",
    "days": [0, 2, 4]
  }
}
```

### PATCH /users/settings

**Request:**
```json
{
  "workoutSchedule": {
    "type": "rotating",
    "weeks": [
      [0, 2, 4, 5],
      [1, 3, 5]
    ]
  }
}
```

### GET /programs/:program

**Response (custom program):**
```json
{
  "id": "5-3-1-custom",
  "name": "5/3/1 (Custom)",
  "description": null,
  "baseTemplate": "5-3-1",
  "createdAt": "2026-05-10T14:23:00Z",
  "specs": [
    {
      "week": 1,
      "offset": 0,
      "lift": "Squat",
      "increment": 5,
      "order": 1,
      "sets": 3,
      "reps": 5,
      "amrap": false,
      "warmUpPct": "40%, 50%, 60%",
      "wtDecrementPct": 10,
      "activation": "leg press"
    }
    // ... more specs
  ]
}

## Core Service Logic

### Workout Distribution Algorithm

**Purpose:** Given N workouts in a cycle, M workouts/week, and a user schedule pattern, produce a list of dates for each workout.

**Location:** `packages/core/src/services/workout/distributeWorkouts.ts` (new file)

**Pseudo-code:**

```typescript
function distributeWorkouts(
  cycleWorkouts: number,            // 12
  userSchedule: UserWorkoutSchedule, // { type: 'fixed', days: [0, 2, 4] }
  cycleStartDate: Date               // May 19, 2026 (Monday)
): { week: number; workouts: Date[] }[] {
  const distribution = [];
  let workoutsPlaced = 0;
  let weekCounter = 0;
  let currentWeekStart = alignToMonday(cycleStartDate);

  while (workoutsPlaced < cycleWorkouts) {
    const weekPattern = getWeekPattern(userSchedule, weekCounter);
    const weekWorkouts: Date[] = [];

    for (const dayIndex of weekPattern) {
      if (workoutsPlaced >= cycleWorkouts) break;

      const workoutDate = addDaysToDate(currentWeekStart, dayIndex);
      weekWorkouts.push(workoutDate);
      workoutsPlaced++;
    }

    if (weekWorkouts.length > 0) {
      distribution.push({
        week: weekCounter + 1,
        workouts: weekWorkouts
      });
    }

    currentWeekStart = addDaysToDate(currentWeekStart, 7);
    weekCounter++;
  }

  return distribution;
}

function getWeekPattern(
  schedule: UserWorkoutSchedule,
  weekIndex: number
): number[] {
  if (schedule.type === 'fixed') {
    return schedule.days || [];
  } else {
    // Rotating: select week pattern cyclically
    const patternIndex = weekIndex % schedule.weeks!.length;
    return schedule.weeks![patternIndex];
  }
}
```

**Returns:** Array of week objects, each containing the dates of that week's workouts.

### Lift Date Scheduling

**Purpose:** When a cycle is created or updated, schedule each lift's dates based on its offset and the workout distribution.

**Location:** Extend `packages/core/src/services/workout/updateLiftDates.ts`

**Changes:**
- Current function updates lift dates when user manually edits one
- New function: `scheduleLiftDates()` — applies the distribution algorithm to all lifts in a cycle spec
- Accepts: cycle number, program spec, user schedule, effective workouts/week
- Produces: lift date assignments for each lift based on its offset

**Algorithm:**
```
For each lift in the cycle spec:
  1. Find all lifts with the same offset (they belong to the same "day")
  2. Get the offset-th workout date from the distribution
  3. Assign that date to all lifts in the offset group
```

### Schedule Workouts Per Week (Display Helper)

Not used to drive distribution — the schedule drives that directly. Used only to display an estimated cycle duration to the user.

**Location:** `packages/core/src/services/workout/` (inline helper or utility)

```typescript
/** Returns the number of workouts per week the schedule supports — used for duration estimates only. */
function getScheduleWorkoutsPerWeek(schedule: UserWorkoutSchedule): number {
  if (schedule.type === 'fixed') {
    return (schedule.days || []).length;
  } else {
    // Rotating: average across all week patterns
    const weeks = schedule.weeks || [[]];
    return Math.round(weeks.reduce((sum, w) => sum + w.length, 0) / weeks.length);
  }
}

// Estimated cycle duration (display only):
// Math.ceil(cycleWorkouts / getScheduleWorkoutsPerWeek(userSchedule)) weeks
```

## Integration Points

### 1. Custom Program Creation/Update

**File:** `packages/core/src/services/workout/` (service or controller layer)

When a custom program is created or its specs are updated:
1. No frequency override to validate or store — the schedule handles date distribution
2. If a cycle is active and the user is in schedule mode, trigger pending-date recalculation via `distributeWorkouts()`

### 2. Schedule Mode Activation

**File:** `packages/core/src/services/workout/` (called from settings and program selection flows)

Fires in two situations:
- User sets or updates their `workoutSchedule` while a program is active
- User selects a program while a schedule is active

**Logic:**
```
prompt user:
  "Use your schedule (Mon/Wed/Fri) to distribute workout dates for this program?"
    Yes → schedule mode: call distributeWorkouts(cycleWorkouts, userSchedule, cycleStartDate)
          store dates; display in cycle dashboard
    No  → no-schedule mode: no dates pre-assigned; date set at logging time
```

No frequency comparison is performed — any schedule works with any program. The pace follows naturally from the schedule.

If there is no active program when the schedule is set, no prompt is shown; the schedule is saved and the prompt fires when the next program is selected.

### 3. Cycle Dashboard Generation

**File:** `packages/core/src/services/dashboard/` (extend existing)

When generating a cycle dashboard:
1. Load user's `workoutSchedule` from settings
2. If no schedule, or user chose no-schedule mode for this program → return cycle data with no pending workout dates
3. Otherwise call `distributeWorkouts(cycleWorkouts, userSchedule, cycleStartDate)` and store dates in the cycle

### 4. Lift Record Creation

**File:** `packages/core/src/services/workout/extractLiftRecords.ts`

When a user logs a set:
1. If the workout has a pre-assigned scheduled date (schedule mode), default to that date
2. If the workout has no scheduled date (no-schedule mode), use today's date as the effective workout date
3. Allow the user to override the date in either case (manual reschedule)

### 5. Settings API

**File:** `apps/api/src/controllers/` or `apps/api/src/routes/`

Add endpoints:
- `GET /users/settings` — return `workoutSchedule`
- `PATCH /users/settings` — update `workoutSchedule`

### 6. Program API

**File:** `apps/api/src/controllers/programs.ts`

No changes to existing program endpoints beyond what is already implemented — programs do not store a workouts-per-week value.

## Type Dependencies

### In `packages/types/src/api.ts`:
- Add `UserWorkoutSchedule` interface
- Extend `UserSettingsResponse` with `workoutSchedule`
- `CustomProgramResponse` and `UpdateCustomProgramRequest` are **not** extended — no workouts-per-week field is stored on programs
- `UpdateCycleOverrides` is **not** extended — date distribution is driven by the schedule, not a cycle-level override
- (Optional) Add new `WorkoutDistributionResponse` if exposing distribution via API

### In `packages/core/src/models/`:
- Optionally create model classes for distribution results if the service layer needs them

## Testing Strategy

### Unit Tests

**`packages/core/tests/services/workout/distributeWorkouts.test.ts`:**
- Fixed schedule: 12 workouts, 3/week, Mon-Wed-Fri → validates 4 weeks, correct day indices
- Rotating schedule: 12 workouts, alternating 4/3 per week → validates distribution respects pattern
- Edge cases: 1 workout, 10 workouts/week (capping), schedule with no days selected

**`packages/core/tests/services/workout/getScheduleWorkoutsPerWeek.test.ts`:**
- Fixed schedule → returns day count
- Rotating schedule → returns rounded average of week lengths
- Edge cases: empty days array, single-week rotation

### Integration Tests

**`apps/api/tests/programs.test.ts`:**
- GET cycle dashboard, no schedule set → no pending dates returned
- GET cycle dashboard, schedule set and schedule mode active → workout dates distributed
- GET cycle dashboard, schedule set but no-schedule mode chosen → no pending dates returned
- Create lift records with no scheduled date → date defaults to today

**`apps/api/tests/users.test.ts`:**
- PATCH settings with `workoutSchedule` → persists
- GET settings → returns schedule with correct structure
- Setting schedule while program active → schedule-mode prompt flag returned (for UI to render)

### E2E Tests (Playwright, once #259 is implemented)

- No schedule set: user logs a set → workout date = today (no pre-assigned date shown)
- User sets Mon-Wed-Fri schedule; program active → schedule-mode prompt shown
  - User chooses schedule mode → cycle dashboard shows dates on Mon/Wed/Fri
  - User declines → cycle dashboard shows no pending dates
- User sets Mon-Tue-Wed-Thu schedule; program active → schedule-mode prompt shown; dates distributed on Mon/Tue/Wed/Thu
- User changes schedule while cycle active → schedule-mode prompt fires again

## Migration & Backwards Compatibility

- Existing users without `workoutSchedule` default to `null` → no-schedule mode; no pending dates; no behavior change from current system
- Existing programs without `workoutsPerWeekOverride` default to `null` → prescribed frequency used when a schedule is later set
- No data migration required: the new columns are nullable and the no-schedule fallback is the correct default for all existing data

## Open Questions

1. **UI for rotating schedules:** Should the rotation start on a specific date, or always be "week A, week B, week A, week B..."?
2. **Partial week handling:** `distributeWorkouts()` stops placing workouts once N are placed — if the last week is partial, remaining days in that week are unused. Is this the correct behavior, or should the system always fill out the final week?
3. **Holiday/deload handling:** Out of scope for MVP. Deferred to future enhancement.
4. **Workout-to-lift mapping:** Is offset the only way to know which lifts belong together, or do we need an explicit "lift group"?
5. **Schedule-mode prompt placement:** Should the prompt appear in the Settings flow (when schedule is saved) or in the Program selection flow (when a program is picked), or both? Both trigger the same yes/no question, so a single flow entry point may be preferable.

## References

- Current implementation: `packages/core/src/services/workout/updateLiftDates.ts` (shows offset-based grouping)
- Type definitions: `packages/types/src/api.ts` and `packages/types/src/domain.ts`
- Macrocycle model: `packages/core/src/models/MacrocycleDashboard.ts`
- Program spec: `packages/core/src/models/LiftingProgramSpec.ts`
