-- A version on each focus block (#1287, ADR-039 Amendment 7). Every update raises it by one,
-- and `PATCH /focus/blocks/:id` refuses a write whose `version` isn't the stored one, so a page
-- that loaded a block before a training max was carried into it can't write the old max back.
--
-- Additive only: a new column with a default, so existing rows start at 1 and no row is
-- updated. The table's FORCE ROW LEVEL SECURITY (Amendment 2) doesn't affect ADD COLUMN.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes the column, so its updates leave the
-- version where it is during the window; the new API's check only compares versions it
-- returned itself, and a client that sends none isn't checked.
--
-- Rollback: reverting the API image alone is safe; the old code ignores the column. A setup
-- page loaded from the new API sends a `version` the old API rejects with a 400 once; the page
-- re-reads after a failed save, gets no version from the old API, and sends none after that.
-- The web only sends a version the API returned, so a new web on the old API sends none.
-- To remove the column:
--   ALTER TABLE "focus_block" DROP COLUMN "version";

SET LOCAL lock_timeout = '5s';

ALTER TABLE "focus_block" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
