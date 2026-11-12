-- Indexes "lift_modification_max"."modificationId" (#1153), so deleting a lift modification finds
-- the own maxes its foreign key cascades to without scanning the table. The unique index leads
-- with "userId", so it can't serve that lookup.
--
-- Additive only, and the table is new in the previous migration, so it is near empty and the
-- build takes no noticeable lock. Rollback: drop the index; nothing reads it by name.

SET LOCAL lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "lift_modification_max_modificationId_idx" ON "lift_modification_max"("modificationId");
