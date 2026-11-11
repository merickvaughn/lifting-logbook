# ADR-042: Every Macrocycle Gets a Row, and a New One Takes the Next Free Number

**Status:** Accepted
**Date:** 2026-11-10
**Issue:** [#1197](https://github.com/merickvaughn/lifting-logbook/issues/1197) (piece 1 of [#1171](https://github.com/merickvaughn/lifting-logbook/issues/1171), top-level [#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170))
**Related:** [Import macrocycle assignment proposal](../proposals/2026-11-06-import-macrocycle-assignment.md) (decisions 1, 2, 3, 13 and 18), [`docs/domain-model.md`](../domain-model.md) D9 and D14, [ADR-039](ADR-039-focus-block-persistence.md) (the pattern for a new user-scoped table)

---

## Context

Before this change, the database stored only the current macrocycle. `macrocycle_dashboard` is unique on user and program, and `macrocycleNum` lives as a bare integer on seven tables: `lift_record`, `macrocycle_dashboard`, the three workout override tables, `focus_day_state` and `macrocycle_scheduled_workout`. A finished macrocycle had no start date, end date or status, and nothing listed past macrocycles ([D9, D14](../domain-model.md#defects)).

Importing history ([#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170)) has to put older macrocycles somewhere. Those macrocycles must not change training maxes, and their numbers must never collide with a live macrocycle. The owner accepted the proposal's design. They split #1171 into four PRs:

1. This one: the table, the guards, the list and the backfill function.
2. The stable id ([#1198](https://github.com/merickvaughn/lifting-logbook/issues/1198)).
3. The renumbering engine ([#1199](https://github.com/merickvaughn/lifting-logbook/issues/1199)).
4. The renumbering backfill, in a later deploy ([#1200](https://github.com/merickvaughn/lifting-logbook/issues/1200)).

The owner's reason for the split: migrations run while the previous API revision still serves. Stored numbers can only change once every client sends the stable id, so the renumbering deploy has to come after the one that adds the table.

## Decision

1. **A `macrocycle` table holds one row per user, program and number.**
   - Each row has a start date, a nullable end date, a status (`completed`, `abandoned`, `overran`, `in-progress`, `unknown`) and whether the lifter chose that status.
   - It also has an origin (`imported`, `live`, `legacy`, `non-cycle`), an `unmatched` flag, and an `importedThrough` date for a continued imported run.
   - CHECK constraints hold status and origin to the lists in `packages/types`.
   - The table has forced row-level security with one isolation policy, in the migration that creates it, as every user-scoped table does [1].
   - `macrocycle_dashboard` stays the pointer to the current macrocycle.

2. **A new macrocycle takes the next free number.** The number is the larger of the highest stored number and the dashboard's, plus one.
   - It applies to every path that creates a macrocycle: initialize, starting the next one, and `fromMacrocycleNum`, which used to reuse the source number + 1.
   - So a new live macrocycle can never land on an imported or legacy number.
   - The unique key is the backstop. When two writers race for one number, the second write fails, and Prisma's `P2002` [2] becomes a 409 with code `macrocycle-number-taken`. The request's transaction rolls back, so nothing is written.
   - Numbers follow start date only after [#1199](https://github.com/merickvaughn/lifting-logbook/issues/1199) adds the renumbering engine. Until then a number is allocated and never rewritten. (The #1199 amendment below adds that engine, behind a setting [#1200](https://github.com/merickvaughn/lifting-logbook/issues/1200) turns on.)

3. **Live macrocycles keep their rows current.**
   - Creating a macrocycle creates its row as `live` and `in-progress`.
   - Starting the next one closes the previous row. Its end date is its last set's date. It's `completed` when every workout of the program has a logged set, and `abandoned` otherwise, because starting the next one is a restart. A workout number past the program's length doesn't count.
   - A program with no known length closes as `unknown`.
   - A status the lifter chose is never overwritten.
   - On read, an `in-progress` row whose last session is more than 14 days old reads as `abandoned`, so it can't go stale. This excludes the current macrocycle and a status the lifter chose.
   - On read, a row's dates widen to cover its sets. Sets logged into a closed macrocycle, or uploaded into a legacy one, don't move the stored dates.

4. **Writes check the macrocycle's row first.**
   - An `imported` number returns 409 with code `macrocycle-read-only`.
   - A number the program doesn't have returns 404 with code `macrocycle-not-found`.
   - `live` and `legacy` numbers stay writable.
   - The guard covers every route in proposal decision 2:
     - `fromMacrocycleNum`.
     - Lift-record `POST`, `PATCH` and import.
     - Lift-override `POST` and `DELETE`.
     - Reschedule.
     - Skip `POST` and `DELETE`.
   - The current macrocycle gets its row on first write if it has none, for macrocycles the previous API revision started. That insert uses `ON CONFLICT DO NOTHING` [3], so two requests creating the row at once both succeed.
   - A file number with no row gets a `legacy` row dated by the file's sets. (Superseded for imports by the #1199 amendment below: a file's number now only groups its rows, and an upload never writes into an `imported` macrocycle.) A file number must be from 0 to 1000, so a typo can't push every later number past it. The upper bound is the one `POST lift-records` applies; the lower is 0 because spreadsheet exports number a first cycle 0. Undoing the import removes a `legacy` row it created once the row has no sets left.
   - With no dashboard, workout and focus routes address the highest number + 1, so an imported number 1 is never read or written as live.
   - Deleting the current macrocycle keeps `imported` rows and their sets.

5. **A backfill function gives every stored number a row.** `macrocycle_backfill_rows()` inserts one row per distinct user, program and number across the seven tables.
   - The dashboard's number is `live`, `in-progress`, and starts on `macrocycleDate`, so it works with zero sets.
   - Every other number is `legacy` with status `unknown`, shown as "Status unknown", because `lift_record` has no origin to tell imported sets from logged ones.
   - A start date comes from the first of these that exists:
     1. The number's first set.
     2. Its first scheduled date.
     3. The start of the nearest lower number.
     4. The program's earliest start.
     5. Today.
   - It inserts with `ON CONFLICT DO NOTHING` [3], so running it again changes nothing.
   - The migration calls it once.
   - #1200 calls it again for numbers the old revision created during the deploy window.
   - `EXECUTE` is revoked from `PUBLIC`, so the app role can't run it.

6. **`GET /programs/:program/macrocycles` lists a program's macrocycles in start-date order.** Each has its id, which stays the same when a number changes, plus its dates, its status as read today, its origin and whether it's current. History shows them on a Macrocycles tab.

## Alternatives rejected

- **Deriving past macrocycles from `lift_record` dates alone.** A status, a chosen status, an empty macrocycle and an unmatched stretch can't be stored or edited that way (proposal decision 1).
- **Widening `macrocycle_dashboard` to hold every macrocycle.** Its uniqueness is one row per user and program, and every reader treats it as the current pointer.
- **Keeping source + 1 for `fromMacrocycleNum`.** That lands on a stored number whenever an imported or legacy macrocycle sits above the source, and the unique key would then fail every such start.
- **Renumbering by start date in this PR.** The previous API revision, still serving while migrations run, doesn't send a stable id, so a rewritten number would point its writes at the wrong macrocycle. The owner chose to split this into its own deploy.
- **A backfill written as one-off migration SQL.** A function can be run again by #1200 and called from the DB e2e suite against seeded rows.

## Consequences

- Two error codes change. `fromMacrocycleNum` for a number the program lacks used to return 400 and now returns 404 `macrocycle-not-found`. Logging a set to a number with no row returns 404, where it used to create the set. The web logger posts to its URL's number, which always has a row.
- Imported history can't be edited set by set. Correcting it means undoing its import ([#1181](https://github.com/merickvaughn/lifting-logbook/issues/1181)).
- `agent-tools.ts` leaves out set notes it can't vouch for. Those are notes on `imported` or `legacy` macrocycles, or dated up to a row's `importedThrough`.
- Download My Data includes the table.
- **Rollback:** reverting the API image is safe, because the old code ignores the table. Dropping the table loses only the rows, which the function can rebuild for any number still stored.

## Amendment: the stable id ([#1198](https://github.com/merickvaughn/lifting-logbook/issues/1198))

**Date:** 2026-11-10

Once [#1199](https://github.com/merickvaughn/lifting-logbook/issues/1199) can renumber macrocycles, a page left open across a renumbering would post to its old number, which then names a different macrocycle. Proposal decision 3 answers this with the row's id, which never changes. This amendment adds it before any number can move.

1. **A workout read returns its macrocycle's id.** `GET` workout responses carry `macrocycleId`. The current macrocycle gets its row first if it has none.

2. **Page writes send the id in an `X-Macrocycle-Id` header.** The routes are lift-record `POST` and `PATCH`, lift-override `POST` and `DELETE`, reschedule, skip `POST` and `DELETE`, `PUT` focus-state, and `fromMacrocycleNum`. Imports address macrocycles by the file's numbers, not a page's, so they don't send one. The owner chose:
   - a header over the URL path, so every route keeps its shape and a client without the id still works;
   - page writes only, over every write.

   Browser writes are cross-origin ([ADR-032](ADR-032-cloud-run-api-public-invoker.md)), so the API's CORS options allow the header. `main.ts` and the preflight test share one options object, so the test checks the real configuration.

3. **The API checks the id against the number in the request.**
   - An id whose row has a different number returns 409 `macrocycle-moved`. The body carries the row's current `macrocycleNum`, and nothing is written.
   - An id with no row in the program returns 404 `macrocycle-not-found`, as when the macrocycle a page showed was deleted and started again. Its message asks the lifter to reload.
   - `PUT` focus-state writes to the current macrocycle, whatever number the page holds. When the id names a row that is no longer current, it returns 409 `macrocycle-not-current` with the current `macrocycleNum`. Reloading at the id's number wouldn't help, so the page shows the API's message instead of following it.
   - A write with no id is accepted and logged as `Macrocycle write without an id (#1198)` with its route. That log shows when every client sends one. [#1200](https://github.com/merickvaughn/lifting-logbook/issues/1200) turns it into a 400.

4. **Macrocycle writes and imports exclude each other through a per-user advisory lock** [6]. Both take the transaction-scoped form inside the request's transaction, so the lock is released when the transaction ends.
   - **Every macrocycle write takes it shared:** the page writes above, starting the next macrocycle (with or without `fromMacrocycleNum`), initializing the first one, and deleting the current one. So does every workout read, before it reads the current number and the id, so the pair it returns agrees. Shared holders don't block each other.
   - **A write takes the lock before it reads what it checks.** Its dashboard read, its id check and the current macrocycle it writes to all come after the lock, so an import can't change them between the read and the write.
   - **A write doesn't wait.** It uses the `try` form, and an import holding the lock gets a 409 `import-in-progress` the lifter can retry. A workout read that can't take it returns no id rather than failing, and the page's writes go without one.
   - **An import waiting for the lock counts as holding it.** Postgres queues a new shared request behind an exclusive one that is waiting [8] (from its lock manager's design notes, not the user documentation; the database test pins it), so while an import waits for page writes, a new page write gets 409 `import-in-progress` and a workout read gets no id. That lasts at most the import's 5-second wait, including when the wait runs out and the import gets `macrocycle-busy`.
   - **An import, and an import's undo, take it exclusively and wait** up to 5 seconds for the shared holders to finish, using `lock_timeout` set for the transaction only [7]. Page writes are short, so the wait is usually nothing. If it runs out, the import gets a 409 `macrocycle-busy` with a message written for the importer: "Your workouts are being saved. Try the import again in a moment." The owner chose the wait over failing the import at once, which would have thrown away an upload because one set was being logged. Each import route's transaction budget is 30 seconds, which leaves room for it.
   - **The key is the single 64-bit value `hashtextextended(userId, 1171)`.** A 32-bit hash would make two users share a lock, and one's import fail the other's writes, within a few tens of thousands of users. `hashtextextended` is Postgres's built-in 64-bit text hash; it isn't in the documented function list, which this decision accepts (observed behaviour, present since PostgreSQL 11).
   - The lock is raw SQL, which OpenTelemetry doesn't trace ([ADR-024](ADR-024-prisma-otel-sdk-override.md)), so it runs inside manual spans: `macrocycle.try_lock` for the shared form and `macrocycle.lock` for the exclusive one, which records the wait and whether it succeeded.
   - An import holds it for its whole commit. #1199's renumbering runs inside imports, so no page write can land between a renumber and its check.
   - **The lock lasts only as long as its transaction.** On the bare `SYSTEM_DATABASE_URL` client, which runs each statement in its own transaction, it's released at once and excludes nothing. Every caller runs inside the request's RLS transaction, and both spans record `lock.in_transaction`, which reads false in that mode.

5. **The web app follows a moved macrocycle.**
   - Workout pages (logger, detail, timer, manage lifts, lift picker, lift editor) redirect to the number the workout was read from when the URL's differs. The read always names the current macrocycle, so the redirect can't loop.
   - Manage Lifts links to the lift picker with the id in a `macrocycleId` query parameter, so the picker sends it without reading the workout again. A stale one is caught by the write. A link without it, such as a bookmark, makes the picker read the workout as the other pages do.
   - A write that gets `macrocycle-moved` reloads the page at the new number. For `import-in-progress`, `macrocycle-not-current` and `macrocycle-not-found` the page shows the API's message, which asks the lifter to try again or to reload.
   - The logger's unsent-set drafts are keyed by the id. A draft saved under the old number key moves to the id key the first time it's read, which the owner chose over keeping both keys.
   - The timer's saved run matches by the id when both sides have one, and by number otherwise. A matched run takes the current key, so its next save carries the id. The run's storage shape is unchanged.

**Alternatives rejected:**

- **The id in the URL path.** Every route and link would change shape at once, and the previous API revision, still serving during the deploy, couldn't answer it.
- **Blocking a page write while an import runs.** A page write would hold a connection and a transaction for the length of an import. A 409 the lifter can retry costs less.
- **Failing an import at once when a page write holds the lock.** The first version did this. A set being logged on a phone would fail an import after its file had uploaded, with a message about an import the importer was the one running.
- **The two-key lock form, (`1171`, `hashtext(userId)`).** Its 32-bit hash lets two users collide.
- **Checking the id on imports.** An import names macrocycles by the file's numbers, which the importer resolves itself.

**Consequences:**

- A page open across a renumbering can't write to another macrocycle. Before #1200, a client that sends no id still can, and the log names it.
- A page write during an import fails with a 409 instead of writing into numbers the import is moving. An import during a page write waits for it.
- **Rollback: the web first, never the API alone.** The previous API revision's CORS options don't allow `X-Macrocycle-Id`, so behind it every write from this web revision fails its browser preflight. Reverting the web drops the header, and the API accepts writes without it until #1200, so after the web the API can follow. A revert merged through the pipeline deploys the API first (`deploy.yml` runs the API's steps before the web's), so pages fail their writes between the two steps; moving the web service's traffic to its previous revision first avoids that. A forward deploy has no such gap, since the API goes first.

## Amendment: renumbering by start date, and counting duplicates ([#1199](https://github.com/merickvaughn/lifting-logbook/issues/1199))

**Date:** 2026-11-11

Proposal decisions 3 and 13 need stored numbers to follow start date, and a file's numbers to stop deciding where its rows land. With the stable id in place (#1198 amendment), this amendment adds both.

1. **A program's macrocycles are numbered 1 to N by start date.** Every path that adds or removes a macrocycle renumbers the program at the end of its transaction: a lift-record import and its undo, starting the next macrocycle, initializing the first one, and deleting the current one.
   - The order is the one `GET /programs/:program/macrocycles` lists: start date, then the number before the rewrite. A tie keeps its order, and a new macrocycle, which takes the number past every stored one, sorts after those it ties with, so undoing it puts the old numbers back.
   - One map of old to new numbers is applied to all eight tables that hold a number: the seven in Context plus `macrocycle`. Postgres checks a non-deferrable unique key row by row [9], so a swap done in one `UPDATE` would collide with itself. The rewrite first moves each row to `-1 - new` and then flips the sign, in the request's transaction.
   - Before it moves anything, the rewrite checks all eight tables for a row on a new number that the map doesn't move. Such a row would merge into the macrocycle that moves onto its number, and the unique keys catch that only when the rest of the key matches too. If one exists, the request fails with 409 `macrocycle-number-taken` and the transaction rolls back. The unique keys stay as the backstop.
   - Removing a macrocycle therefore removes it from all eight tables. This covers the `legacy` macrocycle an undone import emptied. It also covers `live` and `legacy` ones a delete removes, which goes through the same eight-table delete, keeping only the `imported` numbers. Both drop the keys any lift-record batch holds on the removed numbers, because undoing such a batch would otherwise remove sets from whichever macrocycle takes the number next. The database picks out those batches by key number, as it does for a rewrite.
   - The in-memory adapters used by the tests find their numbered stores in the repository bundle, rather than from a hand-kept list. Each store names the table it stands in for, which a refused rewrite reports.
   - The second pass flips only this rewrite's temporary numbers (`-1 - new`), so a stray negative number stored by some other path is never turned positive.
   - The keys of the program's lift-record import batches move in the same transaction. These are current keys, date-blind keys from before [#884](https://github.com/merickvaughn/lifting-logbook/issues/884), and `macrocycle-row:<n>`. So an older batch still undoes the rows it wrote. Only the batches with a key on a moving number are loaded. The database filters them by each key's leading number, read with the one pattern the API reads keys with. An undo deletes its own batch before it renumbers.
   - The rewrite is raw SQL, which isn't auto-traced (ADR-024). A `macrocycle.renumber` span records how many macrocycles moved, rows rewritten, batches rewritten and the duration. A log line names the program after a rewrite that moved something. A failure sets the span's status to error and records the exception. When the check refused the rewrite, the span also names the table and number. A warning is logged with the program, the moves, and the database error.
   - Rows on numbers past every macrocycle that have no `macrocycle` row move with the renumbering, to the numbers right after the last macrocycle. These are rows a page wrote before the program had a macrocycle there, such as a focus state saved before initializing, and they belong to the next macrocycle to start. Without this, an undo that closes a gap would leave them past it.
   - The changed batches' keys are written in one statement. One `UPDATE` per batch took about 2.4 seconds for 50 batches of 400 keys.
   - `rewriteNumbers` has its own `macrocycle.rewrite_numbers` span, since callers other than the renumbering use it too. The `macrocycle.renumber` span's `renumber.duration_ms` counts from when the lock is held, and `renumber.lock_wait_ms` records the wait for it.
   - On a local Postgres 16 in Docker, rewriting 20,010 rows (ten macrocycles of 2,000 sets, each moved up one, as an older import would move them) took 0.95 to 1.05 seconds over three runs. Reversing ten macrocycles' numbers with 50 lift-record batches of 400 keys each took 0.18 to 0.23 seconds over three runs, against 0.03 to 0.06 seconds with no batches. These are the baselines for `renumber.duration_ms`.

2. **The rewrite holds the macrocycle lock exclusively,** so no page write's id check can interleave with it. The renumbering takes it itself whenever a number would move, whichever path called it, so a caller can't skip it.
   - An import and its undo hold it that way already. The lock is re-entrant, so they get it at once.
   - Starting, initializing and deleting hold it shared. They take it exclusively only when a number would move, with the same 5-second wait as an import, then 409 `macrocycle-busy`. They read the order again once they have it. The owner chose this over always taking it exclusively, which would make every start wait on page writes even though a normal start moves nothing.
   - Two shared holders upgrading at once deadlock, and Postgres aborts one of them [10] (`40P01`), as a database test confirms. The aborted request gets `macrocycle-busy` only when it is the one waiting for the exclusive lock. Postgres may instead abort a request blocked elsewhere, such as on a row lock in a delete. That request fails with a 500, and its transaction rolls back, so nothing is half-written.

3. **Renumbering is off until #1200.** It runs only when `MACROCYCLE_RENUMBERING=on`, and nothing sets that yet. The API logs which mode it's in once per value it reads, and warns when the value is something other than `on` or `off`, such as `ON` or `true`, which count as off. While it's off, nothing stored is rewritten, and a new macrocycle takes the next free number as before. The owner chose the setting because two kinds of writer would still post to a number a rewrite had moved: the previous API revision, and a page sending no id. #1200 turns it on in the deploy that renumbers existing history and refuses writes with no id, then removes it.

4. **A file's macrocycle number only groups its rows** (proposal decision 2). This applies to `POST lift-records/import` and to lift-record commits, and it isn't behind the setting, because it moves nothing already stored.
   - A group joins a stored macrocycle, whatever that one's number, when its new sets fall in it. The first new set is on or after the macrocycle's start, and it's the last macrocycle to start by then. The last new set is before the next stored macrocycle starts, if one starts later. A `live` macrocycle, which the app dated, is joined on those dates alone. A `legacy` one is joined only when the group's other rows are sets already stored in it, because its dates came only from the file that formed it. So a sheet uploaded again joins the macrocycle its first upload formed, while a separate file of later sessions forms its own. An `imported` macrocycle is never joined. The owner chose ending at the next start over ending at the macrocycle's end date. A spreadsheet uploaded again after it grew past that end would otherwise add a new macrocycle with every upload.
   - Undoing an import removes each `legacy` macrocycle left with no sets that it created or that its sets were in. So a `legacy` macrocycle one import formed and another joined goes once both are undone.
   - Any other group forms a new `legacy` macrocycle at the next free number. New ones are allocated in order of their first date and inserted in one statement.
   - A program with no current macrocycle can already hold rows on that next number, such as a focus state saved before initializing: page writes address the highest number + 1. Those rows move past the new numbers first, to the number the next macrocycle will take, and undoing the import moves them back. Otherwise the import's macrocycle would take them, and its undo would delete them.
   - A group numbered like an `imported` macrocycle forms a new one too. The owner chose that over the 409 `macrocycle-read-only` such an upload got before, because the file's number is only a label.
   - Page writes to an `imported` number still get that 409.
   - The 0 to 1000 range check stays. Row validation flags it too, so the preview shows the row before a commit is refused.

5. **Duplicates are counted per set slot** (proposal decision 13). A slot is a date, a lift and a set number, with lift names compared through `liftSpellings`. File rows are compared with the user's stored sets under any program.
   - File rows pair with stored rows on the same slot, closest match first: the same workout number with identical weight and reps, then identical weight and reps, then the same workout number, then any. A paired row is skipped. So re-uploading a file adds nothing, whatever numbers it carries, and a workout logged in the app pairs with its own row in a sheet that also holds the day's other workout.
   - A row left over is a real extra set. It keeps its own occurrence unless a row it could collide with under the unique key has it, and otherwise takes the highest of theirs + 1. Those are the stored rows with its workout number and the earlier extras with its file macrocycle and workout number. An extra in another workout keeps its occurrence, so the workout page doesn't show it as a second time through the lift.
   - An exact repeat within one file counts once and is reported as skipped. That means the same slot, macrocycle and workout number, occurrence, weight and reps. A file's numbers are consistent within the file, so two same-day workouts that repeat a set keep both rows, as before this change.
   - A group whose rows are all skipped creates no macrocycle.
   - Preview doesn't yet say how many skipped rows differ in weight or reps; that is a follow-up.

**Alternatives rejected:**

- **Keeping the file's numbers.** A file numbered 3 would leave 1 and 2 empty, and a file numbered like the live macrocycle would write into it, whatever its dates.
- **Renumbering in this deploy.** The previous API revision and pages without an id would write to moved numbers (#1198 amendment).
- **One `UPDATE` per table with the new number.** The unique key is checked per row [9], so a swap of two numbers fails partway.
- **Always taking the lock exclusively to start, initialize or delete.** Every start would wait for page writes, though a normal start moves nothing.
- **Refusing a group numbered like an `imported` macrocycle.** One label would reject the whole file.
- **Matching duplicates by the full natural key.** The key holds the macrocycle number, which the file no longer decides, so a re-upload would write every set again.
- **Letting the unique keys alone catch a row left on a target number.** A row whose other key columns differ, such as a skip on another workout, would merge silently into the macrocycle that moved onto the number.
- **Ending a joined group at the macrocycle's end date.** Each upload of a growing sheet would form another macrocycle.
- **Joining a group to the macrocycle with its number.** With renumbering off, a file's number rarely matches the stored one, so each upload of a growing sheet formed another macrocycle.
- **Joining a group to whichever macrocycle its dates fall in.** Two files of separate cycles uploaded one after the other would merge into one `legacy` macrocycle when nothing stored starts between them.
- **Joining only where the group's rows are stored.** A first upload of the current cycle's sessions would form a `legacy` macrocycle beside the `live` one, instead of filling it in.

**Consequences:**

- **Lifts that read as one lift now match across spellings.** A stored Pull-up and a file's Weighted Pull-up on the same slot now pair, so the file's row is skipped. Before, it was written as a second set. A set stored under another program on the same slot pairs too.
- An upload numbered like an `imported` macrocycle succeeds, where it was refused.
- While the setting is off, numbers are allocated and never rewritten, as before. With it on, numbers are dense and in date order after every change listed in decision 1. Overwrite, clear and a range edit get the same check in [#1181](https://github.com/merickvaughn/lifting-logbook/issues/1181) and [#1182](https://github.com/merickvaughn/lifting-logbook/issues/1182).
- **Rollback:** while the setting is off, reverting the API image is safe, because nothing has been rewritten. Once #1200 turns it on, a revert needs #1200's reversal script to put the old numbers back.

## References

1. [PostgreSQL 16 — Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)
2. [Prisma — Error message reference, `P2002`](https://www.prisma.io/docs/orm/reference/error-reference#p2002)
3. [PostgreSQL 16 — `INSERT`, `ON CONFLICT` clause](https://www.postgresql.org/docs/16/sql-insert.html#SQL-ON-CONFLICT)
4. [PostgreSQL 16 — PL/pgSQL, obtaining the result status (`GET DIAGNOSTICS`)](https://www.postgresql.org/docs/16/plpgsql-statements.html#PLPGSQL-STATEMENTS-DIAGNOSTICS)
5. [PostgreSQL 16 — Explicit locking, row-level locks](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS): a second insert of a key held by an uncommitted transaction waits for that transaction, then fails, which the concurrency test relies on.
6. [PostgreSQL 16 — Advisory lock functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS): `pg_try_advisory_xact_lock_shared` returns at once, `pg_advisory_xact_lock` waits, and both release at transaction end.
7. [PostgreSQL 16 — Client connection defaults, `lock_timeout`](https://www.postgresql.org/docs/16/runtime-config-client.html#GUC-LOCK-TIMEOUT), set for one transaction with [`set_config(..., true)`](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SET). A wait that runs out fails with `lock_not_available` ([SQLSTATE `55P03`](https://www.postgresql.org/docs/16/errcodes-appendix.html)).
8. [PostgreSQL 16 source — lock manager README, `src/backend/storage/lmgr/README`](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/storage/lmgr/README): a lock request that conflicts with a request already waiting is queued behind it, rather than granted ahead of it.
9. [PostgreSQL 16 — `CREATE TABLE`, Compatibility, "Non-Deferred Uniqueness Constraints"](https://www.postgresql.org/docs/16/sql-createtable.html#SQL-CREATETABLE-COMPATIBILITY): a non-deferrable unique constraint is checked immediately as each row is inserted or modified, not at the end of the statement.
10. [PostgreSQL 16 — Explicit locking, deadlocks](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-DEADLOCKS): Postgres detects a deadlock and aborts one of the transactions involved.
