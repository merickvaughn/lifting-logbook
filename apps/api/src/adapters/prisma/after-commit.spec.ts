import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AFTER_COMMIT_TIMEOUT_MS, runAfterCommit, settleAfterCommit } from './after-commit';

/** After-commit work (#1444, ADR-047 decision 16): bounded by 2 s, and it never fails the request. */
describe('settleAfterCommit', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  it('stops waiting for work that never finishes after 2 s, and logs the timeout', async () => {
    jest.useFakeTimers();
    const never = jest.fn(() => new Promise<void>(() => undefined));
    let settled = false;
    const settling = settleAfterCommit([never]).then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(AFTER_COMMIT_TIMEOUT_MS - 1);
    expect(never).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await settling;
    expect(settled).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: 'rls.after_commit', outcome: 'timeout' }), expect.any(String));
  });

  it('resolves as soon as the work finishes, without a log', async () => {
    const work = jest.fn(async () => undefined);
    await settleAfterCommit([work]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves when the work throws, and logs the failure by count only', async () => {
    await expect(settleAfterCommit([() => Promise.reject(new Error('Bearer secret')), async () => undefined])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ operation: 'rls.after_commit', outcome: 'failed', callbacks: 2, failed: 1 }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});

describe('runAfterCommit', () => {
  it('throws outside a request the interceptor set up, so the work is never dropped quietly', () => {
    const cls = { get: () => undefined } as unknown as ClsService;
    expect(() => runAfterCommit(cls, async () => undefined)).toThrow('outside a request');
  });
});
