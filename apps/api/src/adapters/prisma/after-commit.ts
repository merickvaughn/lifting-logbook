import { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';

/** CLS key for the work a request registers to run once its transaction commits (#1444). */
export const RLS_AFTER_COMMIT = 'rls.afterCommit';

/**
 * The longest a response waits for its after-commit work (ADR-047, decision 16). Cloud Run with
 * request-based billing gives an instance no CPU once the response is sent, so the work runs
 * before it, and this bounds what it can add to the response time.
 */
export const AFTER_COMMIT_TIMEOUT_MS = 2_000;

export type AfterCommitCallback = () => Promise<unknown>;

const logger = new Logger('AfterCommit');
const tracer = trace.getTracer('rls-interceptor');

/**
 * Registers `fn` to run once the request's transaction has committed, before the response is sent.
 * Nothing registered runs when the transaction rolls back or the handler throws. Throws when no
 * request context is set up, so work can't be dropped without anyone knowing.
 */
export function runAfterCommit(cls: ClsService, fn: AfterCommitCallback): void {
  const callbacks = cls.get(RLS_AFTER_COMMIT) as AfterCommitCallback[] | undefined;
  if (!callbacks) throw new Error('runAfterCommit called outside a request RlsInterceptor set up');
  callbacks.push(fn);
}

/**
 * Runs the callbacks a committed request registered, waiting at most {@link AFTER_COMMIT_TIMEOUT_MS}.
 * Never throws: the request has committed, so its response can't depend on this work. A failure
 * or a timeout is logged and traced by outcome and counts only.
 */
export async function settleAfterCommit(callbacks: AfterCommitCallback[]): Promise<void> {
  if (callbacks.length === 0) return;
  await tracer.startActiveSpan('rls.after_commit', async (span) => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), AFTER_COMMIT_TIMEOUT_MS);
    });
    // allSettled never rejects, so a callback that fails after the timeout leaves nothing unhandled.
    const settled = Promise.allSettled(callbacks.map((fn) => Promise.resolve().then(fn)));
    try {
      const result = await Promise.race([settled, timedOut]);
      const failed = result === 'timeout' ? 0 : result.filter((r) => r.status === 'rejected').length;
      const outcome = result === 'timeout' ? 'timeout' : failed > 0 ? 'failed' : 'done';
      span.setAttributes({ 'rls.after_commit.outcome': outcome, 'rls.after_commit.callbacks': callbacks.length });
      if (outcome !== 'done') {
        span.setStatus({ code: SpanStatusCode.ERROR });
        logger.warn(
          { operation: 'rls.after_commit', outcome, callbacks: callbacks.length, failed },
          'After-commit work did not finish before the response (#1444)',
        );
      }
    } finally {
      clearTimeout(timer);
      span.end();
    }
  });
}
