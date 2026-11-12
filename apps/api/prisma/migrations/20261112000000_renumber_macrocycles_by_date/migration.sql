-- Superseded by 20261112000001_renumber_macrocycles_by_date (#1200, PR #1231 review).
--
-- Staging applied an early draft of the renumbering under this name. `prisma migrate deploy`
-- skips a migration it has recorded as applied and doesn't compare its contents, so a fix made
-- here would never reach staging, and staging would never run the SQL production runs. This name
-- now does nothing, and the next migration holds the renumbering, written to run over the draft
-- as well as over a database that never had it.
SELECT 1;
