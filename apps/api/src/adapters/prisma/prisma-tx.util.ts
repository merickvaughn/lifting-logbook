import { Prisma, PrismaClient } from '@prisma/client';

/**
 * A Prisma client capable of running queries: either the base client (which can open
 * transactions) or an interactive-transaction client (which cannot — it is already inside a
 * transaction). The RLS request interceptor (rls.interceptor.ts) routes every repository through
 * a per-request transaction client so the `app.current_user_id` GUC stays in scope; outside an
 * HTTP request (in-memory factory, standalone unit tests) repositories get the base client.
 */
export type PrismaExecutor = PrismaClient | Prisma.TransactionClient;

/**
 * The base client can start transactions; Prisma's interactive transaction client cannot
 * (it exposes no `$transaction`). This is the runtime discriminator between the two.
 */
function canStartTransaction(client: PrismaExecutor): client is PrismaClient {
  return typeof (client as PrismaClient).$transaction === 'function';
}

/**
 * Run a set of writes atomically. With the base client this opens a batch transaction; with a
 * request-scoped transaction client the writes are already inside a transaction, so they run
 * sequentially on it (Prisma's tx client supports no nested `$transaction`). Either way the caller
 * gets all-or-nothing semantics — for the request-scoped case, because the enclosing request
 * transaction rolls back on any thrown error.
 */
export async function runBatch(
  client: PrismaExecutor,
  build: (c: PrismaExecutor) => Prisma.PrismaPromise<unknown>[],
): Promise<void> {
  const ops = build(client);
  if (canStartTransaction(client)) {
    await client.$transaction(ops);
  } else {
    for (const op of ops) {
      await op;
    }
  }
}

/**
 * Transaction budget for batch import writes (#532). A large (but within-limit)
 * import can exceed Prisma's 5s default interactive-tx timeout and throw P2028, so
 * imports get a wider window than the {@link DEFAULT_RLS_TX_TIMEOUT_MS} default.
 *
 * This single value governs **both** import paths so they can't drift:
 * - **Request path** (the production HTTP import): `runInteractive` reuses the RLS
 *   request transaction and ignores the options below, so every HTTP import handler
 *   carries `@RlsTxTimeout(IMPORT_TX_TIMEOUT_MS)` to widen that enclosing transaction —
 *   `ImportController.import`/`.undoImport`, and (since #911) `LiftRecordsController
 *   .importLiftRecords`. Named individually rather than "ImportController" alone so this
 *   list doesn't go stale again the next time an HTTP import handler is added (#911
 *   review, ninth pass — round 8 added the third carrier without updating this comment).
 * - **Self-opened path** (system-DB factory / unit tests, where the repository holds
 *   the base client): `runInteractive` opens its own transaction with the options below.
 *
 * Note the request path only ever receives `timeout`, never `IMPORT_BATCH_TX_OPTIONS`'s
 * `maxWait` — `RlsInterceptor` reads a single `Reflect.getMetadata` number, not an options
 * object, so a busy pool can still P2028 at connection *acquisition* on the request path
 * even though the self-opened path is guarded against exactly that. Pre-existing since
 * `ImportController` first carried this decorator (#532), not introduced by round 8's
 * third carrier — tracked as a follow-up rather than fixed here since correcting it means
 * widening `RlsTxTimeout`'s metadata shape for every existing carrier, not just the new one.
 */
export const IMPORT_TX_TIMEOUT_MS = 30_000;

/**
 * `runInteractive` options for the self-opened-tx path. `timeout` matches
 * {@link IMPORT_TX_TIMEOUT_MS}; `maxWait` is raised in step so a busy pool does not
 * P2028 while acquiring the connection.
 */
export const IMPORT_BATCH_TX_OPTIONS = { timeout: IMPORT_TX_TIMEOUT_MS, maxWait: 5_000 } as const;

/**
 * Run an interactive transaction. With the base client this opens one; with a request-scoped
 * transaction client it reuses the current transaction (Prisma does not nest interactive
 * transactions, and reusing the request transaction keeps the RLS GUC in scope).
 *
 * `options` (timeout / maxWait) apply only when this opens its own transaction; on the
 * reuse path the enclosing request transaction's own timeout governs.
 */
export async function runInteractive<T>(
  client: PrismaExecutor,
  fn: (tx: PrismaExecutor) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  if (canStartTransaction(client)) {
    return client.$transaction((tx) => fn(tx), options);
  }
  return fn(client);
}
