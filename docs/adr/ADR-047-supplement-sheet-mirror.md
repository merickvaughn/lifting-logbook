# ADR-047: The Supplement Sheet Mirror Writes With a `drive.file` OAuth Grant, KMS-Encrypted Refresh Tokens and a Cloud Tasks Queue

**Status:** Accepted
**Date:** 2026-11-22
**Issue:** [#1380](https://github.com/merickvaughn/lifting-logbook/issues/1380) (part of [#1372](https://github.com/merickvaughn/lifting-logbook/issues/1372), Supplements 8/9)
**Related:** [ADR-040](ADR-040-google-sheets-link-import.md) (the Sheets import, which reads link-shared workbooks without OAuth); [ADR-014](ADR-014-credential-encryption-at-rest.md) (KMS envelope encryption, whose scheme this reuses); [ADR-046](ADR-046-supplement-storage.md) (supplement storage and its change log, the mirror's input); [ADR-005](ADR-005-authentication-strategy.md) (Clerk); [ADR-032](ADR-032-cloud-run-api-public-invoker.md) (the API is publicly invokable, so the app checks every caller itself); [ADR-033](ADR-033-log-header-allowlist.md) (log header allowlist); the Supplements proposal (`docs/proposals/2026-11-18-supplements-module.md`, in [PR #1384](https://github.com/merickvaughn/lifting-logbook/pull/1384)), "Import and mirror"

---

## Context

The Supplements module is the source of truth for a lifter's stack. The proposal mirrors the stack
one way to a Google Sheet the lifter owns, so they can keep reading it where they kept it before.
The app never reads the sheet back.

Nothing in the app can write to Google today. ADR-040's import downloads a link-shared workbook as
XLSX with no credential and no scope. ADR-014 designed KMS envelope encryption for per-user Google
credentials, but the table it encrypts, `user_data_source`, was never built. What does exist on
`main`:

- **KMS.** `infra/terraform/main.tf` creates a key ring and the `user-data-source-kek` key (90-day
  rotation), and `cloud-run.tf` passes it to the API as `KMS_KEY_NAME`. No API code uses it yet.
  The API's service account, `api_workload` (used by Cloud Run as well as GKE), holds
  `roles/cloudkms.cryptoKeyEncrypterDecrypter` and `roles/secretmanager.secretAccessor` at project
  level (`gke.tf`).
- **Secret Manager** holds the database URLs and the Clerk keys. The Clerk ones are created with a
  `REPLACE_ME` version that the owner fills in by hand.
- **Postgres via Prisma.** Every per-user table has `ENABLE` and `FORCE ROW LEVEL SECURITY` and an
  isolation policy on `app.current_user_id`, and the API connects as the `NOBYPASSRLS` role
  `lifting_app`.
- **Cloud Run only.** Both environments set `enable_gke = false`. The API service sets
  `cpu_idle = true`, with request-based billing, so Cloud Run gives the instance CPU only while it
  is handling a request. Work left running after a response has no CPU to run on. Scheduled work
  today runs as a Cloud Run job started by a GitHub workflow (ADR-044). There is no queue.
- **Supplement writes** commit the new state and their `supplement_change` rows in one
  transaction, numbered by `seq` per user (ADR-046).

Issue #1380 asks for an ADR covering how the app gets permission to write, which OAuth flow it
uses, where tokens live and how they are protected, how revocation and unlinking work, how the
mirror runs without blocking a write, what is sent to Google and when, and what may be logged.

## Decision

### Permission

1. **Google OAuth 2.0 with only the `https://www.googleapis.com/auth/drive.file` scope.** It gives
   the app access only to files it creates, or that the user opens with it or picks. Google lists
   `drive.file` as non-sensitive and recommends it for Sheets apps, whereas `spreadsheets` is
   sensitive and `drive` is restricted. `spreadsheets.create` and `spreadsheets.batchUpdate` both
   accept it. No sign-in scopes (`openid`, `email`, `profile`) are requested.
2. **The app creates the sheet.** **Link a Google Sheet** creates a new spreadsheet in the
   lifter's Drive, named "Lifting Logbook — Supplements", with a "Supplements" tab and a "History"
   tab. Picking an existing sheet (the Google Picker) is not part of this decision; see
   Alternatives. `drive.file` allows it, so it can be added later without asking for a new scope.
3. **Requested in context, never at sign-in.** The consent screen appears only when the lifter
   presses **Link a Google Sheet** in Settings → Data, as Google's best practices advise for
   incremental authorization. The Google account they link doesn't have to be the one they sign in
   with, or a Google account at all, since sign-in goes through Clerk.

### OAuth flow

4. **The web server flow (authorization code grant), with a confidential client, PKCE and offline
   access.** The authorization request carries `response_type=code`, `scope=drive.file`,
   `access_type=offline`, `prompt=consent` (so a re-link always returns a refresh token; Google
   returns one only on the first consent otherwise), `include_granted_scopes=false`, a `state`, and
   a `code_challenge` with `code_challenge_method=S256`. Google documents these parameters in its
   guide for installed apps, on the same authorization and token endpoints a web client uses; its
   web server guide doesn't mention them, so the first staging link confirms that the web client
   accepts them. If it doesn't, the flow drops PKCE and relies on `state` and the client secret.
   RFC 9700 recommends PKCE for confidential clients too. It also means an authorization code that
   ends up in a log or trace can't be redeemed without the verifier.
5. **The API owns the flow; the web app only relays it.**
   1. Settings → Data calls `POST /integrations/google-sheet/authorize` (Clerk-authenticated). The
      API generates 32 random bytes each for `state` and the PKCE verifier, upserts one
      `google_oauth_request` row for the user (state hash, verifier, expiry 10 minutes later), and
      returns the authorization URL. The browser goes there.
   2. Google redirects to the web origin, `https://<web>/settings/data/google-sheet/callback`. That
      Next.js route handler runs on the server, under the lifter's Clerk session. It posts `code`
      and `state` to `POST /integrations/google-sheet/callback`, then redirects to `/settings/data`
      without the query string, as Google advises.
   3. The API takes the Clerk user's own `google_oauth_request` row. It checks that the row hasn't
      expired and that the SHA-256 hash of the incoming `state` matches in constant time, and
      deletes the row. A single-use state tied to the signed-in user is the CSRF protection
      RFC 6749 §10.12 asks for. The API then exchanges the code at
      `https://oauth2.googleapis.com/token` with the client secret and the verifier.
   4. It checks that the `scope` returned includes `drive.file`. Users can decline scopes on
      Google's granular consent screen, so if it's missing, the API stores nothing and Settings
      says that access wasn't granted.
   5. It creates the spreadsheet, stores the link (decision 7), and enqueues the first mirror.
   The redirect URI is on the web origin because that is the address the lifter's browser already
   has a Clerk session cookie for. The client secret stays in the API. Clerk's session cookie is
   set on the exact host, not shared with subdomains, so a session on `www.liftinglogbook.com`
   isn't one on `liftinglogbook.com`. The web app therefore redirects every `www` request to the
   bare domain with a 308 (`apps/web/next.config.ts`, #1436), so a lifter is only ever signed in
   on the host the production callback uses, and production registers that one redirect URI.
6. **Access tokens are never stored.** Each mirror run uses the refresh token to get an access
   token (valid about an hour), keeps it in memory for that run, and drops it. A run makes at most
   three Google calls, so caching an access token between runs would save one token request per
   run, at the cost of a second credential at rest.

### Token storage

7. **One `google_sheet_link` row per user, with the refresh token envelope-encrypted as ADR-014
   specifies.** Each write generates a fresh 32-byte data key and 12-byte nonce and encrypts the
   token with AES-256-GCM. The additional authenticated data is `"google_sheet_link:" || userId`,
   so a ciphertext copied into another user's row fails to decrypt. The data key is wrapped by
   Cloud KMS. The row stores the ciphertext, the wrapped key and the nonce. The plaintext token
   exists only in memory, while a request or mirror run uses it.
8. **A new key, `google-oauth-token-kek`, in the existing key ring**, with the same 90-day rotation
   and `prevent_destroy`. It isn't `user-data-source-kek` because that key belongs to ADR-014's
   unbuilt table. A key used only for Google tokens means that disabling it stops every mirror at
   once and nothing else, and rotating or re-encrypting it touches only this table. The API service
   account already has encrypt and decrypt on every key in the project. Narrowing that grant to
   per-key bindings is a separate hardening step and isn't part of this decision.
9. **The OAuth client secret goes in Secret Manager** as `${name_prefix}-google-oauth-client-secret`,
   created with a `REPLACE_ME` version and `ignore_changes`, like the Clerk secret. It is injected
   into the API as `GOOGLE_OAUTH_CLIENT_SECRET`. The client ID isn't secret and is a plain env var,
   `GOOGLE_OAUTH_CLIENT_ID`. With no client ID set, the Link button isn't shown and the API answers
   503 `google-sheet-unconfigured`, so local development, CI and e2e runs need no Google client.

### Revocation and unlinking

10. **Unlink** (Settings → Data): in one request, the API decrypts the refresh token and revokes it
    with a `POST` to `https://oauth2.googleapis.com/revoke`, as Google's web server guide describes
    under "Token revocation". The token goes in the form body, never
    the query string, so the outbound HTTP span doesn't record it. RFC 7009 §2.1 says a server
    revoking a refresh token should also invalidate the access tokens issued from it, and no
    access token outlives the run that used it anyway (decision 6). The API then deletes the row whatever
    the revoke returned. If the revoke fails, the response says so and links to the Google account
    permissions page, so the lifter can remove access there. The spreadsheet is left in their Drive
    and is theirs to keep or delete. A mirror task that runs after the unlink finds no row and
    returns 204.
11. **`invalid_grant` on refresh** covers a user who revoked access in their Google account, a
    token unused for six months, more than 100 live tokens for one account on one client, and the
    7-day expiry of a client in Testing status. The run deletes the three ciphertext columns, sets
    `status = needs_relink`, records `lastErrorCode = 'invalid_grant'`, and returns 204 so Cloud
    Tasks doesn't retry. Settings shows "Google access was removed. Link again." Linking again runs
    decision 5. If the lifter still has the spreadsheet and the app can still open it, the link
    keeps that spreadsheet. Otherwise it creates a new one.
12. **The spreadsheet is gone.** The adapter maps Google's errors by their status and reason, not
    by the HTTP code alone. A `NOT_FOUND`, or a `PERMISSION_DENIED` on the spreadsheet itself rather
    than on the token, means the lifter deleted the sheet or can no longer reach it through
    `drive.file`. A 403 for a rate or quota reason (`rateLimitExceeded`, `userRateLimitExceeded`, or
    another quota reason) is retried like a 429 and never means the sheet is gone. For a missing
    sheet the run sets `status = sheet_missing` and returns 204. Settings offers **Create a new sheet**, which
    reuses the stored token.
13. **Re-linking replaces the stored token without revoking the old one.** Google's revocation
    removes the project's whole grant for that Google account, so revoking the old token after the
    new one was issued would kill the new one too. A re-link only follows `needs_relink` (the old
    token is already dead) or an Unlink (already revoked), so there is rarely a live old token. If
    the lifter links a different Google account, the old account's token is overwritten in the row
    and never used again; its grant stays at Google until six months of disuse expire it, and the
    lifter can remove it from that account's permissions page. The 100-token limit doesn't argue
    for revoking either: Google invalidates the oldest token past the limit, never the newest.
14. **Account deletion and Clear data.** When account deletion reaches this table, it revokes the
    token and deletes the row, as Unlink does. Clear data leaves the link and the sheet alone. It
    keeps the supplement stack and its change log, as setup (ADR-046), and the sheet mirrors exactly
    those, so the sheet still matches the app after Clear data.

### How the mirror runs

15. **A Cloud Tasks queue, `supplement-sheet-mirror`, calls an internal API endpoint.** With
    `cpu_idle = true`, a timer or promise left running after the response has no CPU, so the
    debounce, the retries and the Google calls can't run inside the request that made the change.
    Cloud Run's own documentation suggests Cloud Tasks for this. The queue lives in each
    environment's project. Retry settings: `max-attempts 8`, `min-backoff 10s`, `max-backoff 600s`,
    `max-doublings 5`, `max-retry-duration 24h`. Rate settings: `max-dispatches-per-second 1` and
    `max-concurrent-dispatches 5`, which keeps the project under the Sheets API's 300 writes a minute
    at three writes per run. The backoff follows Google's advice for 429s: truncated exponential
    backoff, with the maximum raised from their typical 32 or 64 s to 10 minutes because nobody is waiting on a
    mirror.
16. **Enqueued after commit, debounced by task name, and never able to fail the write.** After a
    supplement write's transaction commits, and only if the user has a `linked` row (read in the
    write's own transaction), the service creates a task named `<userId-hash>-<window>`, where `window` is the current 30-second window,
    with `scheduleTime` at the end of that window. Cloud Tasks deduplicates named tasks, so every
    change in the window enqueues one run. Cloud Tasks answers `ALREADY_EXISTS` for every change
    after the first in a window, and the service counts that as success, not a failure. A name
    stays reserved for up to a day after its task finishes, which is why each name carries its
    window. **Sync now** names its task `<userId-hash>-sync-<window>` and schedules it at once, so
    repeated presses in one window enqueue one run; the follow-up run in decision 19 uses the
    normal name for the window it falls in. The response doesn't depend on the enqueue's outcome,
    and it waits at most 2 s for it: with request-based billing, Cloud Run gives an instance CPU
    only while it processes a request, so an enqueue left running after the response could stall
    or never run ([CPU allocation](https://docs.cloud.google.com/run/docs/configuring/cpu-allocation)).
    The write registers the enqueue as after-commit work, and `RlsInterceptor`
    runs it once the transaction has committed and before the response is sent; a rollback or an
    error runs none. A failure or a timeout is logged and traced and the write still returns its
    normal response. The next committed change enqueues again, and Settings shows the last
    mirror time with a **Sync now** button that enqueues a run. A write that changes nothing, which
    logs no change (ADR-046), enqueues nothing.
17. **The task carries only the user ID.** Its body is `{ "userId": "<id>" }`. The run reads the
    current stack and the change log itself, so a late or duplicate run still writes the latest
    state. Nothing from the stack and no token sits in the queue.
18. **The endpoint checks the caller itself.** ADR-032 made the API publicly invokable, so Cloud
    Run IAM can't gate `POST /internal/supplement-sheet-mirror`. Tasks carry an OIDC token for a
    dedicated service account, `sheet-mirror-tasks`. The endpoint skips the Clerk guard and
    instead verifies that the token is Google-signed, that its audience is the API's own URL, and
    that `email` is that service account with `email_verified`. Anything else gets a 401. It then
    runs the mirror with `app.current_user_id` set to the task's user, so RLS still confines the
    run to that user.
19. **One run per user at a time, and atomic sheet writes.** A run first takes a lease in a short
    transaction (`UPDATE … SET "mirrorLeaseUntil" = now() + 5 min WHERE "mirrorLeaseUntil" IS NULL
    OR "mirrorLeaseUntil" < now()`), by the database's clock. Five minutes is more than twice the
    longest a run can hold it: 125 s for a 20 s change-log read, two 20 s KMS calls, three 20 s
    Google calls and a 5 s record. If the lease is held, it returns 409 and Cloud Tasks retries.
    Every later write of the run is conditional on the row still holding the lease it took, for
    the same spreadsheet, and none creates a row: a run never recreates a link the lifter deleted
    during it, or writes over a link to another sheet. Recording never lowers `lastMirroredSeq`.
    The run reads the stack and the change log, and the highest `seq`, in a second short
    transaction. It calls Google with no transaction open, so no pooled connection is held during
    network calls (ADR-040, decision 4). It writes both tabs in **one `spreadsheets.batchUpdate`**:
    an `addSheet` for any tab that's missing, created with a grid the size of its rows, or an
    `updateSheetProperties` that resizes an existing tab's grid to them, then an `updateCells` over
    each tab's whole range, which clears whatever the new rows don't cover. A tab's grid is fixed
    (1000 rows by 26 columns for a new one), so without the resize a History past it couldn't be
    written and a shorter tab would keep blank rows below its data. Google applies a `batchUpdate` atomically, so the
    lifter never sees a half-cleared tab. Cells are written as `stringValue` and `numberValue`,
    never `formulaValue`, so a note beginning with `=` stays text. Last, it records
    `lastMirroredSeq` and `lastMirroredAt` and releases the lease. If the highest `seq` has moved on
    since the read, it enqueues one more run.
20. **What the tabs hold.** "Supplements" has one row per item and dose: name, slot, amount,
    servings, day types, timing, notes, links and status, with a header row. "History" has one row
    per `supplement_change`: date, change type, item and a readable summary, newest first. Both tabs
    are rewritten whole on every run. Neither carries the app's user ID or internal IDs.
21. **Outcomes Cloud Tasks acts on:** 2xx for success and for the terminal states in decisions 10
    to 12; 409 for a held lease; 5xx for a Google 429 or 5xx, a KMS or database failure, or a
    timeout. Cloud Tasks retries those, and Google's calls get a 20 s timeout each. Once retries run
    out, the last error code stays on the row and Settings shows "Last sync failed" with Sync now.
    Any other Google 4xx but a 408 (a 400, say) is terminal too, since a retry would send the same
    request: the run stores `google_<status>` as the last error, releases the lease, logs at `error`
    and answers 204. A 409 is expected contention, logged at `info` and never as a failure.

### What is sent to Google, and when

22. **Nothing until the lifter links a sheet.** Until a `linked` row exists, the API makes no call to
    any Google endpoint for that user, and a supplement write doesn't enqueue a task. Tests assert
    this with a fake Sheets client and a fake queue that both fail the test if called.
23. **After linking, only the two tabs' contents**, which come from the lifter's own stack and
    history, go to the Sheets API. They go to the lifter's own spreadsheet, under the grant they gave
    on Google's consent screen. The OAuth exchange sends the code and verifier, and the revoke sends
    the token. Nothing about other users, the lifter's training data or their Clerk identity is
    sent.

### Observability

24. **Spans and logs carry outcomes and counts, never credentials or contents.** The enqueue and
    each run get a manual span (`sheet_mirror.enqueue`, `sheet_mirror.run`). Their attributes are
    the outcome, the attempt number (`X-CloudTasks-TaskRetryCount`), the HTTP status and error
    reason from Google, the row counts per tab, the `seq` mirrored and the link's status. Never
    recorded: access or refresh tokens, authorization codes, `state` or the verifier, the client
    secret, the OIDC token, the spreadsheet ID or URL, or any cell value. Failures are logged at
    `warn` (retryable) or `error` (retries exhausted, `invalid_grant`, `sheet_missing`) with the
    same fields, so log lines join their traces through the existing `trace_id` mixin.
25. **Google client errors are mapped before they reach a logger.** The `googleapis`/`gaxios` error
    object holds its request config, including the `Authorization` header and the request body. The
    adapter converts it to `{ status, reason }` at the boundary, and a test fails if a logged
    payload contains the fake token or a fake cell value (the #1380 acceptance criterion).
26. **The callback URL's query is scrubbed from web traces.** The callback request URL carries
    `code` and `state`. The web app removes the query string from that route's span attributes.
    Cloud Run's own request log still records the URL, which is acceptable because the code is
    single-use, expires in minutes, and can't be redeemed without the client secret and the PKCE
    verifier.
    The same query reaches `/sign-in` when the lifter's session has ended, because the middleware
    redirects there with the callback URL in `redirect_url`. A span whose URL names the callback
    path, plain or percent-encoded, is scrubbed the same way.

## Migration outline (approved by the owner, 2026-11-22)

One migration adds two tables. Both have `userId` with `ENABLE` and `FORCE ROW LEVEL SECURITY` and
the usual isolation policy, and `lifting_app` gets `SELECT, INSERT, UPDATE, DELETE` on each. No
existing table changes.

```prisma
enum GoogleSheetLinkStatus {
  linked
  needs_relink
  sheet_missing
  @@map("google_sheet_link_status")
}

model GoogleSheetLink {
  userId                    String                @id
  status                    GoogleSheetLinkStatus
  spreadsheetId             String
  spreadsheetUrl            String
  grantedScope              String                // as returned by the token endpoint
  refreshTokenCiphertext    Bytes?                // null once status is needs_relink
  refreshTokenDekCiphertext Bytes?                // data key wrapped by google-oauth-token-kek
  refreshTokenNonce         Bytes?                // 12-byte GCM nonce
  lastMirroredSeq           Int?                  // highest supplement_change.seq written
  lastMirroredAt            DateTime?
  lastErrorCode             String?               // a code only, e.g. invalid_grant, rate_limited
  mirrorLeaseUntil          DateTime?
  createdAt                 DateTime              @default(now())
  updatedAt                 DateTime              @updatedAt
  @@map("google_sheet_link")
}

model GoogleOauthRequest {
  userId       String   @id                       // one pending link attempt per user
  stateHash    Bytes                               // SHA-256 of state
  codeVerifier String                              // PKCE verifier; deleted at callback
  expiresAt    DateTime                            // createdAt + 10 minutes
  createdAt    DateTime @default(now())
  @@map("google_oauth_request")
}
```

A check constraint requires the three ciphertext columns to be all set when `status` is `linked`
or `sheet_missing` (decision 12 reuses the token) and all null when `status = 'needs_relink'`. Download My Data exports `status`, `spreadsheetUrl`,
`lastMirroredAt` and `createdAt` from `google_sheet_link`, never the ciphertext columns, and
nothing from `google_oauth_request`. Expired `google_oauth_request` rows are ignored when read and
replaced by the user's next attempt, so no cleanup job is needed. The migration is reversible by
dropping both tables and the enum. A linked lifter would then lose the link and have to link
again, and the tokens left at Google would expire after six months unused.

## Alternatives considered

- **A service account the lifter shares the sheet with.** The app would hold one service-account
  key and the lifter would share a sheet with its email address as an editor. No consent screen
  and no per-user tokens. Rejected: every lifter's sheet would be reachable by one credential, so a
  leaked key exposes all of them; a typo in the shared address, or sharing the wrong sheet, would
  write a stack into a sheet the app shouldn't touch; and the app can't create a sheet in the
  lifter's Drive, so the lifter would have to set up the sheet and the sharing by hand. Unlinking
  would depend on the lifter remembering to stop sharing.
- **The `spreadsheets` scope.** It covers every spreadsheet the user has. Rejected: it's broader
  than a one-way mirror into one file needs, and it is a sensitive scope, which needs Google's full
  app verification, with an "unverified app" warning and a lifetime cap of 100 new users until that
  verification passes.
- **The `drive` scope.** All of the user's Drive. Rejected: restricted, so Google limits it to
  certain kinds of app and requires a security assessment once its data is stored or sent through
  servers, and it is far broader than the need.
- **Apps Script bound to the lifter's sheet,** pulling the stack from an API endpoint on a timer
  or pushing on open. Rejected: the lifter would have to install and authorize a script and give it
  an API credential for the app, which needs a new per-user API key the app doesn't have. The
  mirror would run on the lifter's script quotas and fail where the app can't see it, and every
  lifter would run their own copy of the code.
- **Tokens from Clerk's Google connection.** Clerk's backend can return a user's Google access
  token (`getUserOauthAccessToken`), and only with the app's own Google client ("custom
  credentials"). Rejected: it works only for lifters who sign in with Google, and only for the
  Google account they sign in with. It would mean asking for `drive.file` at sign-in rather than
  when the lifter links a sheet. It would also put a write credential for the lifter's Drive in a
  third party's store, outside the KMS key and RLS that protect everything else. Clerk's docs, as
  read, don't say whether it refreshes offline tokens with extra scopes, which a mirror run with no
  user present depends on.
- **Client-side writes with a short-lived token** (Google Identity Services' token model in the
  browser, no refresh token). Nothing would be stored server-side. Rejected: the mirror has to run
  after each committed change, including changes made from mobile or by a later retry. A
  browser-only token exists only while that tab is open, lasts about an hour, and needs a Google
  prompt to renew it. A failed write would be lost when the tab closes, and retrying with backoff
  isn't possible.
- **Running the mirror in the API process** (a debounced timer after the response). Rejected:
  `cpu_idle = true` gives the instance no CPU outside requests, an instance can be stopped with the
  timer pending, and retries wouldn't survive a restart. Switching the API to instance-based
  billing would fix the CPU but not the lost-on-restart problem, and would cost more for every
  request.
- **An outbox table drained by a scheduled Cloud Run job** (the ADR-044 pattern). Rejected for
  now: a daily or even per-minute job is either slow or runs constantly for an occasional event,
  and reading every user's outbox needs owner-only RLS policies like ADR-044's. Cloud Tasks gives
  per-task retry and backoff without any of that. If enqueue failures turn out to matter, a sweep
  job that re-enqueues links whose `lastMirroredSeq` trails the log is the follow-up.
- **The `spreadsheets.values` API** (`batchClear` then `values.batchUpdate` with `RAW`). Rejected:
  that's two requests, so a failure between them leaves a cleared tab. One
  `spreadsheets.batchUpdate` is atomic and needs one write instead of two.
- **The Google Picker, to choose an existing sheet.** Rejected for this issue: it needs a browser
  API key and a browser access token, and the lifter's old sheet has their own columns and
  formulas, which a mirror that rewrites whole tabs would destroy. Creating a dedicated sheet
  avoids both. `drive.file` covers a picked file, so this can be added later.
- **Caching access tokens, or storing the code verifier encrypted.** Rejected: an hour-long access
  token saves one refresh per run, and the verifier lives ten minutes and is useless without the
  code. Neither is worth another credential at rest.

## Consequences

- A lifter can link a sheet from any Google account, and the app sees only that one file.
- Two tables, one KMS key, one Secret Manager secret, one Cloud Tasks queue and one service account
  are added. KMS goes from configured to in use: each mirror run makes one KMS decrypt call and a
  Google token request, and adds about 5 to 10 ms of KMS latency per ADR-014's estimate. The
  mirror is never on a write's path.
- A mirror lags a change by up to 30 seconds (the rest of its window), longer during retries. The sheet can be stale for up
  to 24 hours of retries before Settings reports the failure.
- Staging's OAuth client stays in Testing status, so staging links expire after seven days and only
  listed test users can link. That is expected there, not a bug.
- A lifter who makes no change for six months loses the grant (Google's inactivity rule) and is
  asked to link again. Refreshing on a timer just to keep the token alive is not done.
- Both tabs are rewritten on every run, so edits the lifter makes in them are overwritten. Settings
  and the sheet's header row say so. The History tab grows with the change log; a cap, if needed,
  is a later decision.
- If Cloud Tasks, KMS or Google is down, mirroring stops and resumes when the next run gets
  through. Supplement writes are unaffected.

### Operational steps for the owner

1. In each GCP project (staging, production): enable the Google Sheets API and Cloud Tasks API.
   Enabling the Drive API is needed only if the Picker is added later.
2. Configure the OAuth consent screen (Google Auth Platform → Branding, Audience, Data access):
   user type External; add only the `drive.file` scope; add a support email, the app homepage and
   a privacy policy URL.
3. Production: verify `liftinglogbook.com` in Google Search Console with an owner or editor of the
   project and add it as an authorized domain. Publish a homepage that isn't only a sign-in page,
   and a privacy policy on that domain that describes the mirror. The app has no privacy policy
   page today. Submit brand verification so the consent screen shows the app's name and logo, then
   set the publishing status to **In production**. With only `drive.file`, no sensitive- or
   restricted-scope verification is needed.
4. Staging: leave the publishing status at **Testing** and add the test accounts (up to 100).
5. Create an OAuth client of type "Web application" per environment, with redirect URIs
   `https://liftinglogbook.com/settings/data/google-sheet/callback` only in production (`www`
   redirects to the bare domain, decision 5) and the staging web service's `https://…run.app/settings/data/google-sheet/callback`
   in staging. Don't add `localhost` to either client; local development runs without a client
   (decision 9).
6. Put each client secret into `${name_prefix}-google-oauth-client-secret` (after the Terraform
   apply creates the `REPLACE_ME` version), and the client ID into the deploy configuration. The
   API's deploy uses `gcloud run services replace` with Terraform ignoring the template, so the new
   env var and secret reference go into the deploy pipeline as well as `cloud-run.tf`.
7. Approve the Terraform changes: the `google-oauth-token-kek` key, the secret, the
   `supplement-sheet-mirror` queue, the `sheet-mirror-tasks` service account, and
   `roles/cloudtasks.enqueuer` plus `iam.serviceAccountUser` on `sheet-mirror-tasks` for the API
   service account, which needs `actAs` to attach that account's OIDC token to a task. The Cloud
   Tasks service agent's default role mints the token; the Terraform PR checks this against the
   Cloud Tasks authentication docs and adds a grant only if they require one.

## Security and privacy

- **What leaves the app:** the lifter's supplement stack and its history, to the Google Sheets API,
  into a spreadsheet in the lifter's own Drive. Notes are free text and may hold health
  information, so the Link screen says what is written, that the sheet is stored in their Google
  account under Google's terms, and that unlinking stops future writes but doesn't delete the
  sheet.
- **Consent:** given twice, once in the app (pressing Link after reading what is sent) and once on
  Google's consent screen for `drive.file`. Nothing is sent before both.
- **To whom:** Google only, acting for the lifter. The sheet is private to the lifter unless they
  share it themselves.
- **Credentials at rest:** refresh tokens are encrypted with a per-row data key under a KMS key the
  database never sees, and bound to the user by the additional authenticated data. RLS confines a
  row to its owner, and the token is never returned by any API response or export.
- **Blast radius:** a leaked refresh token reaches one lifter's mirror file. With the database and
  the KMS key both compromised, an attacker could edit or delete the mirror files of linked lifters,
  but not read or change anything else in their Drive.
- **Callers:** the mirror endpoint accepts only an OIDC token from `sheet-mirror-tasks` for the
  API's audience, and the OAuth callback accepts only a state that the signed-in user's own pending
  request issued.

## Questions the owner settled (2026-11-22)

1. **Clear data and the sheet.** Clear data leaves the link and the sheet alone (decision 14).
   The owner first chose to empty the sheet after a dated backup, on the premise that Clear data
   removes the stack; it doesn't (ADR-046), so on review the owner chose to leave the sheet as it is.
2. **Showing the linked Google account.** No. Settings shows the sheet's link only, so the app asks
   for `drive.file` alone and stores no Google email address.
3. **Staging's redirect URI.** The staging client registers today's `run.app` callback, and
   `docs/deploy.md` says to update it if that URL changes. No staging custom domain is added.
4. **Cross-Account Protection (RISC).** Not used. A revoked grant is found at the next refresh
   (decision 11), which sends nothing because the grant no longer works.

## References

1. Google Identity, [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server) — `access_type=offline`, `prompt=consent`, `state`, granular consent and checking the returned `scope`, the token and revoke endpoints, and redirect URI rules.
2. Google Identity, [Using OAuth 2.0 to Access Google APIs — Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration) — six months unused, revocation, 100 tokens per account per client, and the 7-day expiry in Testing status.
3. Google Identity, [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app) — `code_challenge`, `code_challenge_method=S256` and `code_verifier` on Google's authorization and token endpoints.
4. Google Identity, [OAuth 2.0 best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices) — incremental authorization, the narrowest scopes, encrypting stored tokens, revoking and deleting tokens no longer needed, and Cross-Account Protection.
5. Google Workspace, [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) — `drive.file` is non-sensitive and per-file; `drive` is restricted and needs a security assessment when stored on servers.
6. Google Workspace, [Choose Google Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes) — `spreadsheets` is sensitive; `drive.file` is the recommended non-sensitive scope.
7. Google Sheets API v4, [`spreadsheets.create`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create) and [`spreadsheets.batchUpdate`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate) — both accept `drive.file`; a `batchUpdate` is applied atomically.
8. Google Sheets API v4, [`UpdateCellsRequest`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#UpdateCellsRequest) — cells in the range that the rows don't cover are cleared; and [`ValueInputOption`](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption) — `RAW` stores values unparsed, the `spreadsheets.values` route rejected above.
9. Google Sheets API, [Usage limits](https://developers.google.com/workspace/sheets/api/limits) — 300 writes a minute per project and 60 per user, 429 when exceeded, and truncated exponential backoff.
10. Google Cloud, [Manage app audience](https://support.google.com/cloud/answer/15549945) — Testing status, 100 test users, 7-day expiry of test authorizations, and the 100-user cap for unverified apps with sensitive scopes.
11. Google Cloud, [Brand verification requirements](https://support.google.com/cloud/answer/13464321) and [OAuth app verification](https://support.google.com/cloud/answer/13463073) — verified authorized domains, homepage and privacy policy; full verification only for sensitive or restricted scopes.
12. Google Workspace, [Google Picker API overview](https://developers.google.com/workspace/drive/picker/guides/overview) — the file picker considered for choosing an existing sheet.
13. Google Cloud, [Billing settings for services](https://docs.cloud.google.com/run/docs/configuring/billing-settings) — with request-based billing, CPU is allocated only during request processing; Cloud Tasks suggested for background work.
14. Google Cloud, [Create HTTP target tasks](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks) — OIDC tokens for Cloud Run handlers and `scheduleTime`; [`projects.locations.queues.tasks.create`](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create) — deduplication by task name, `ALREADY_EXISTS`, and how long a used name stays reserved; and [Configure Cloud Tasks queues](https://docs.cloud.google.com/tasks/docs/configuring-queues) — retry and rate settings.
15. Google Cloud KMS, [Envelope encryption](https://cloud.google.com/kms/docs/envelope-encryption) — the data-key and key-encryption-key scheme from ADR-014.
16. Clerk, [Google social connection](https://clerk.com/docs/authentication/social-connections/google) and [`getUserOauthAccessToken()`](https://clerk.com/docs/reference/backend/user/get-user-oauth-access-token) — token retrieval needs custom credentials; the alternative rejected above.
17. IETF, [RFC 6749 — The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749) — the authorization code grant (§4.1), refresh tokens (§6) and CSRF protection with `state` (§10.12).
18. IETF, [RFC 7636 — Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636) — the `S256` code challenge.
19. IETF, [RFC 9700 — Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700) — PKCE recommended for confidential clients (§2.1.1) and CSRF requirements (§4.7).
20. IETF, [RFC 7009 — OAuth 2.0 Token Revocation](https://www.rfc-editor.org/rfc/rfc7009) — a server revoking a refresh token should also invalidate access tokens issued from it (§2.1).
21. NIST, [SP 800-38D — GCM](https://csrc.nist.gov/publications/detail/sp/800-38d/final) — AES-GCM with additional authenticated data and 96-bit nonces.
22. OWASP, [Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) — centralized secret storage (§2.2), least privilege (§2.3), envelope encryption (§4.2), and that secrets are never logged.
23. Clerk, [How Clerk works](https://clerk.com/docs/guides/how-clerk-works/overview) — the `__session` cookie is set on the app's own domain and not shared with subdomains (decision 5, #1436).
24. Next.js, [`redirects`](https://nextjs.org/docs/app/api-reference/config/next-config-js/redirects) — `has` host matching and `permanent: true` returning 308 (decision 5, #1436).
25. Google Cloud, [Configure CPU allocation](https://docs.cloud.google.com/run/docs/configuring/cpu-allocation) — with request-based billing an instance gets CPU only while it processes a request, so a write waits for its enqueue rather than leaving it to run after the response (decision 16, #1444).
