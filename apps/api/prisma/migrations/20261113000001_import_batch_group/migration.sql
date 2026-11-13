-- Groups the batches of one import (#1254). An import through the Assign step can store rows
-- under several programs, and each batch's keys are read under its own program, so it saves one
-- batch per program. The Source program's batch has no "groupId"; the others carry its id, so
-- undoing it undoes them all.
--
-- Additive only: a nullable column with no default, so existing rows aren't rewritten, and an
-- index on a small table. Rollback: drop the index and the column; a batch saved with a group
-- then undoes only its own program's rows, so undo grouped imports first.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "import_batch" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE INDEX "import_batch_userId_groupId_idx" ON "import_batch"("userId", "groupId");
