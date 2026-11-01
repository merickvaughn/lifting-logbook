# ADR-017: Training Max History — Dedicated Table vs. Derived from lift_record

**Status:** Accepted
**Date:** 2026-05-05
**Closes:** [#174](https://github.com/merickvaughn/lifting-logbook/issues/174)

---

## Context

The `/settings/training-maxes` page mockup (see `docs/mockups/user-journeys.html`, Cycle Dashboard journey → Training Maxes view) shows a history timeline with:

- PR flags per entry (user-toggleable)
- Source labels: "Test Week" vs. "Program Cycle"
- "Goal Met" markers (user-toggleable)

The existing `training_max` table holds only the latest max per `(userId, program, lift)`. There is no record of prior values, when they changed, or why.

Two approaches were considered:

1. **Derive from `lift_record`**: Reconstruct history by scanning lift records, inferring max updates heuristically (e.g., best set per session, highest ever logged weight).
2. **New `training_max_history` table**: Append a row each time a max changes (cycle advance, recalculate, manual edit).

---

## Decision

Use a dedicated **`training_max_history` table** populated on every max-changing write.

---

## Rationale

### Why the derivation approach fails

`lift_record` contains logged set data but lacks the two annotations the mockup requires:

- **Source** (`test` vs. `program`): Heuristically distinguishing a test-week max update from a normal cycle advance is fragile. The `weekType` field lives on `CycleDashboard` at the time of the write, not on the records themselves. Post-hoc inference would require joining cycle metadata that may have changed.
- **PR / goalMet flags**: These are user judgements, not computable from performance data. A PR flag captures "this was a personal record at the time", which cannot be reliably reconstructed later (the user may have since exceeded it).

A heuristic derivation might cover the 80% case today, but every future schema change or edge case at test-week/deload boundaries would silently corrupt the derived view.

### Why a new table is correct

- **Explicit write path**: `CycleGenerationService` already knows which maxes changed (it diffs `prevMaxes` vs. `newMaxes`). Appending a history row is a one-liner at the call site with zero inference needed.
- **Source is known at write time**: the current week type is derivable from `weekTypeForDate(dashboard.cycleDate, programSpec)` before the write; computing it then is reliable. Reconstructing it later is not.
- **User overrides are first-class**: `isPR` and `goalMet` are mutable boolean columns. They cannot live on a derived view.
- **Query simplicity**: Filtering history by lift, source, or isPR is a straightforward indexed query. A derived approach would require multi-table aggregation on every page load.
- **Append-only semantics**: History rows are never updated on max changes — each change is a new row. Only `isPR` and `goalMet` are mutable (user corrections). This makes the table easy to reason about and audit.

### Trade-offs accepted

- History rows accumulate over time (one per changed lift per cycle). At typical usage rates (1–2 cycles/month, 4 lifts) this is ~100 rows/year/user — negligible at any scale this application will encounter.
- Manual `PATCH /training-maxes` calls (direct user edits on the settings page) do **not** currently write a history row. This is intentional: the settings form is a correction tool, not a progression tool. Adding history rows for manual edits is deferred to a future issue if it becomes needed.

---

## Implementation

**Schema** (`apps/api/prisma/schema.prisma`):
```prisma
model TrainingMaxHistory {
  id        String   @id @default(cuid())
  userId    String
  program   String
  lift      String
  weight    Float
  reps      Int      @default(1)
  date      DateTime
  isPR      Boolean  @default(false)
  source    String   // "test" | "program"
  goalMet   Boolean  @default(false)
  createdAt DateTime @default(now())

  @@index([userId, program])
  @@index([userId, program, lift])
  @@map("training_max_history")
}
```

**Write path**: `CycleGenerationService.startNewCycle` and `recalculateMaxes` diff old vs. new maxes and call `ITrainingMaxHistoryRepository.appendHistoryEntries` for changed lifts. Source is `'test'` when the closing macrocycle's current week is a test week, otherwise `'program'`. Since [#1028](https://github.com/merickvaughn/lifting-logbook/issues/1028) that week comes from `weekTypeForDate(program, dashboard.macrocycleDate, programSpec, { scheduled, overrides })`: the week of its latest workout dated on or before today, read before the new macrocycle's schedule is saved. Historically the week type was read from a `currentWeekType` column on the dashboard, but that column was a placeholder — it was overwritten at request time and never authoritative — and was removed in [#361](https://github.com/merickvaughn/lifting-logbook/issues/361).

**Read path**: `GET /programs/:program/training-maxes/history` with optional `?lift=`, `?source=`, `?isPR=` query params.

**Mutation path**: `PATCH /programs/:program/training-maxes/history/:id` accepts `{ isPR?, goalMet? }`.

All three paths are implemented behind `ITrainingMaxHistoryRepository` with a Prisma adapter and an in-memory adapter, following the existing hexagonal adapter pattern ([ADR-002](ADR-002-ports-and-adapters.md), [ADR-004](ADR-004-multi-data-store-adapters.md)).

---

## References

| Source | Relevance |
|---|---|
| [Prisma — `createMany`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany) | Batch insert API used by `PrismaTrainingMaxHistoryRepository.appendHistoryEntries`. |
| [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) | Background pattern: storing state changes as a sequence of events rather than deriving history post-hoc from current state. The `training_max_history` table is a lightweight application of this principle. |
| [ADR-002 — Ports and Adapters](ADR-002-ports-and-adapters.md) | `ITrainingMaxHistoryRepository` follows the same port/adapter boundary pattern established in ADR-002. |
| [ADR-013 — Testing Strategy](ADR-013-testing-strategy.md) | History repository has both in-memory and Prisma adapters to satisfy the dual-adapter testing requirement. |
