-- The macrocycles an import through the Assign step created or extended (#1255, proposal
-- decision 14), by their stable id, kept apart from the batch's lift-record keys. Undo
-- recomputes each from the sets left on it, or removes it when none are, rather than restoring
-- a pre-image, which is wrong once a later batch has added rows to the same macrocycle. Ids
-- don't change when a renumbering moves a macrocycle, so nothing rewrites this column.
--
-- Additive only: a nullable column with no default, so existing rows aren't rewritten.
-- Rollback: drop the column; the previous revision ignores it, and an Assign import saved with
-- it then undoes its sets but leaves its macrocycle rows, so undo those imports first.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "import_batch" ADD COLUMN "macrocycles" JSONB;
