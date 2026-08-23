import { withTimeout } from '../with-timeout';

describe('withTimeout', () => {
  it('resolves with the promise value when it settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('fast'), 50, 'fallback')).resolves.toBe('fast');
  });

  it('resolves with the fallback when the timer wins (a hung promise)', async () => {
    const hung = new Promise<string>(() => {}); // never settles
    await expect(withTimeout(hung, 20, 'fallback')).resolves.toBe('fallback');
  });

  it('resolves with the fallback, not a rejection, when the wrapped promise rejects', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'fallback')).resolves.toBe(
      'fallback',
    );
  });

  it('calls onTimeout only when the timer wins, never on a normal resolution', async () => {
    const onResolved = jest.fn();
    await withTimeout(Promise.resolve('fast'), 50, 'fallback', onResolved);
    expect(onResolved).not.toHaveBeenCalled();

    const onTimedOut = jest.fn();
    await withTimeout(new Promise<string>(() => {}), 20, 'fallback', onTimedOut);
    expect(onTimedOut).toHaveBeenCalledTimes(1);
  });

  it('does not surface an unhandled rejection when a "lost" race rejects after the timer already won', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      let rejectLoser!: (reason: unknown) => void;
      const loser = new Promise<string>((_resolve, reject) => {
        rejectLoser = reject;
      });

      await expect(withTimeout(loser, 20, 'fallback')).resolves.toBe('fallback');

      // Reject the loser AFTER the race has already settled via the timeout — this is
      // the "lost race" case #933's suggested fix calls out: the abandoned promise must
      // not throw unhandled once it eventually settles.
      rejectLoser(new Error('late rejection from the abandoned call'));
      // Flush microtasks so a genuinely unhandled rejection would have been reported by now.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('clears the timer once the promise wins, leaving no dangling handle', async () => {
    jest.useFakeTimers();
    try {
      const result = await withTimeout(Promise.resolve('fast'), 1000, 'fallback');
      expect(result).toBe('fast');
      // A cleared timer is removed from Jest's fake-timer queue immediately (no need to
      // advance time) — a dangling handle would still show up here.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
