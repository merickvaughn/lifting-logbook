import { logClientError } from '../log-client-error';

// The shared chokepoint every client-side mutation form routes its failures through
// (#783). These lock the contract the call sites and their tests depend on: a stable,
// greppable prefix; the raw error passed through untouched; optional structured context
// only when non-empty; never throwing from inside a catch block; and (since #798) a
// best-effort same-origin beacon to /api/client-errors for OTel/Grafana export.
describe('logClientError', () => {
  let errorSpy: jest.SpyInstance;
  let beaconSpy: jest.Mock;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // jsdom does not implement navigator.sendBeacon — install a mock so the
    // dispatch is observable and never touches the network. Defaults to success.
    beaconSpy = jest.fn(() => true);
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beaconSpy;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
  });

  // ---- console.error contract (unchanged from #783) -------------------------

  it('logs the operation under a stable [client-mutation] prefix with the raw error', () => {
    const err = new Error('boom');
    logClientError('rescheduleWorkout', err);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[client-mutation] rescheduleWorkout failed', err);
  });

  it('appends structured context as a third argument when provided', () => {
    const err = new Error('boom');
    logClientError('createLiftRecord', err, { program: '5-3-1', setNum: 2 });

    expect(errorSpy).toHaveBeenCalledWith(
      '[client-mutation] createLiftRecord failed',
      err,
      { program: '5-3-1', setNum: 2 },
    );
  });

  it('omits the context argument entirely when the context object is empty', () => {
    logClientError('skipWorkout', new Error('x'), {});

    // An empty context must not be forwarded as a third arg — keeps the console line clean.
    const call = errorSpy.mock.calls[0];
    expect(call).toHaveLength(2);
  });

  it('does not throw on a non-Error thrown value', () => {
    expect(() => logClientError('undoImport', 'a string failure')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      '[client-mutation] undoImport failed',
      'a string failure',
    );
  });

  // ---- beacon dispatch (#798) -----------------------------------------------

  function beaconPayload(): Record<string, unknown> {
    expect(beaconSpy).toHaveBeenCalledTimes(1);
    const [url, body] = beaconSpy.mock.calls[0] as [string, string];
    expect(url).toBe('/api/client-errors');
    return JSON.parse(body);
  }

  it('beacons the failure to /api/client-errors with operation, name, message, and context', () => {
    logClientError('rescheduleWorkout', new Error('Slot taken'), { program: '5-3-1', macrocycleNum: 3 });

    expect(beaconPayload()).toEqual({
      operation: 'rescheduleWorkout',
      name: 'Error',
      message: 'Slot taken',
      context: { program: '5-3-1', macrocycleNum: 3 },
    });
  });

  it('serializes a non-Error thrown value via String() and omits name and empty context', () => {
    logClientError('undoImport', 'a string failure', {});

    expect(beaconPayload()).toEqual({
      operation: 'undoImport',
      message: 'a string failure',
    });
  });

  it('never throws when sendBeacon itself throws, and still logs to the console', () => {
    beaconSpy.mockImplementation(() => {
      throw new Error('beacon exploded');
    });

    expect(() => logClientError('skipWorkout', new Error('x'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[client-mutation] skipWorkout failed', expect.any(Error));
  });

  it('does not throw when sendBeacon is unavailable (SSR / non-browser safety), and still logs', () => {
    // No fetch fallback by design (apps/web forbids raw fetch) — when sendBeacon
    // is absent the report is simply dropped, but the console.error must still fire.
    delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;

    expect(() => logClientError('patchLiftMetadata', new Error('x'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('never throws when the thrown value is stringify-hostile, and still logs', () => {
    // String(Object.create(null)) throws "Cannot convert object to primitive value".
    // buildReport (which calls String(error)) runs inside the dispatch try/catch,
    // so that throw must not escape logClientError into the caller's catch block.
    const hostile = Object.create(null) as unknown;

    expect(() => logClientError('patchLiftMetadata', hostile)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
