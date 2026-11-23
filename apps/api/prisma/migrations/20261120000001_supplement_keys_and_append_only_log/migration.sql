-- Supplements (#1374), after review: user-scoped keys, an append-only change log enforced by the
-- grants, two more change types, and an index for the as-of read. See
-- docs/adr/ADR-046-supplement-storage.md. The review's schema changes are kept separate from
-- 20261120000000, whose own fixes (its lock timeout and header) were edited into it before it
-- merged, so production gets them. A local database that applied an earlier version of either
-- migration needs `prisma migrate reset`.
--
-- 1. supplement_item is keyed by ("userId", "id"), and the dose and mix-part foreign keys name
--    both columns. Foreign-key and unique checks bypass RLS, so a key on "id" alone would let a
--    later client-chosen id find, or cascade into, another user's item.
-- 2. lifting_app loses UPDATE and DELETE on supplement_change: the log is append-only in the
--    database, not only in code. The owner role, which runs migrations, keeps them. The staging
--    seed's reset keeps every supplement table whichever role runs it (ADR-046).
-- 3. day_types_set and caffeine_cutoff_set join the change types, so every write to the stack is
--    logged.
-- 4. ("userId", "date") on supplement_change, for GET /supplements/as-of/:date.
--
-- Locks: the tables are new and small, but each ALTER takes an ACCESS EXCLUSIVE lock, so the
-- lock timeout makes the migration fail rather than wait behind a request, and it can be re-run.
--
-- RLS: unchanged. Every table keeps its forced userId isolation policy from 20261120000000.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API writes neither new change type, and doesn't update or delete changes.
--
-- Rollback: the old API works against this schema, so the database needs no change. To reverse
-- it, restore the single-column key and foreign keys, the old CHECK list (after deleting rows of
-- the two new types), drop the index, and GRANT UPDATE, DELETE ON "supplement_change" TO
-- "lifting_app".

SET LOCAL lock_timeout = '5s';

-- 1. User-scoped keys.
ALTER TABLE "supplement_dose" DROP CONSTRAINT "supplement_dose_itemId_fkey";
ALTER TABLE "supplement_mix_part" DROP CONSTRAINT "supplement_mix_part_mixId_fkey";

DROP INDEX "supplement_dose_itemId_idx";
DROP INDEX "supplement_dose_userId_idx";
DROP INDEX "supplement_item_userId_idx";
DROP INDEX "supplement_mix_part_mixId_idx";
DROP INDEX "supplement_mix_part_userId_idx";

ALTER TABLE "supplement_item" DROP CONSTRAINT "supplement_item_pkey",
ADD CONSTRAINT "supplement_item_pkey" PRIMARY KEY ("userId", "id");

CREATE INDEX "supplement_dose_userId_itemId_idx" ON "supplement_dose"("userId", "itemId");
CREATE INDEX "supplement_mix_part_userId_mixId_idx" ON "supplement_mix_part"("userId", "mixId");

ALTER TABLE "supplement_dose" ADD CONSTRAINT "supplement_dose_userId_itemId_fkey" FOREIGN KEY ("userId", "itemId") REFERENCES "supplement_item"("userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplement_mix_part" ADD CONSTRAINT "supplement_mix_part_userId_mixId_fkey" FOREIGN KEY ("userId", "mixId") REFERENCES "supplement_item"("userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Append-only for the app.
REVOKE UPDATE, DELETE ON "supplement_change" FROM "lifting_app";

-- 3. Change types; the list matches packages/types/src/supplements.ts.
ALTER TABLE "supplement_change" DROP CONSTRAINT "supplement_change_type_check";
ALTER TABLE "supplement_change"
  ADD CONSTRAINT "supplement_change_type_check" CHECK ("type" IN ('added', 'edited', 'moved', 'started',
    'moved_to_pending', 'removed', 'restored', 'confirmed', 'mix_created', 'folded_into_mix', 'mix_split',
    'day_types_set', 'caffeine_cutoff_set'));

-- 4. The as-of read.
CREATE INDEX "supplement_change_userId_date_idx" ON "supplement_change"("userId", "date");
