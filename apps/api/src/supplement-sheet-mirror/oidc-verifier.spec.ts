import { generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { GoogleOidcVerifier } from './oidc-verifier';

/** Google signing-key caching in the sheet mirror's OIDC check (#1443, ADR-047 decision 18). */

const AUDIENCE = 'https://api.example.run.app';
const EMAIL = 'sheet-mirror-tasks@project.iam.gserviceaccount.com';
const EXPECTED = { audience: AUDIENCE, email: EMAIL };
const T0 = Date.parse('2026-11-23T12:00:00Z');
const HOUR = 60 * 60_000;

const k1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const k2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key: KeyObject, kid: string) => ({ ...key.export({ format: 'jwk' }), kid });

function token(kid: string, signer: KeyObject): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64({
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    email: EMAIL,
    email_verified: true,
    exp: Math.floor(T0 / 1000) + 10 * 3600,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), signer).toString('base64url')}`;
}

describe('GoogleOidcVerifier key cache', () => {
  let now: number;
  const clock = () => now;
  beforeEach(() => {
    now = T0;
  });

  it('fetches again for an unknown kid at most once a minute', async () => {
    const fetchKeys = jest.fn().mockResolvedValue([jwk(k1.publicKey, 'k1')]);
    const verifier = new GoogleOidcVerifier(fetchKeys, clock);
    expect(await verifier.verify(token('k1', k1.privateKey), EXPECTED)).toBe(true);
    expect(fetchKeys).toHaveBeenCalledTimes(1);

    now += 61_000;
    expect(await verifier.verify(token('k2', k2.privateKey), EXPECTED)).toBe(false);
    now += 1_000;
    expect(await verifier.verify(token('k2', k2.privateKey), EXPECTED)).toBe(false);
    expect(await verifier.verify(token('k-other', k2.privateKey), EXPECTED)).toBe(false);
    expect(fetchKeys).toHaveBeenCalledTimes(2);

    // A minute on, a key Google has since published is picked up.
    fetchKeys.mockResolvedValue([jwk(k1.publicKey, 'k1'), jwk(k2.publicKey, 'k2')]);
    now += 60_000;
    expect(await verifier.verify(token('k2', k2.privateKey), EXPECTED)).toBe(true);
    expect(fetchKeys).toHaveBeenCalledTimes(3);
  });

  it('shares one fetch between requests that arrive while it runs', async () => {
    type Key = ReturnType<typeof jwk>;
    let resolve: (keys: Key[]) => void = () => undefined;
    const fetchKeys = jest.fn(() => new Promise<Key[]>((r) => (resolve = r)));
    const verifier = new GoogleOidcVerifier(fetchKeys, clock);
    const both = Promise.all([verifier.verify(token('k1', k1.privateKey), EXPECTED), verifier.verify(token('k1', k1.privateKey), EXPECTED)]);
    resolve([jwk(k1.publicKey, 'k1')]);
    expect(await both).toEqual([true, true]);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it('keeps verifying with the cached keys when a refresh after the TTL fails', async () => {
    const fetchKeys = jest.fn().mockResolvedValueOnce([jwk(k1.publicKey, 'k1')]).mockRejectedValue(new Error('Google signing keys: 503'));
    const verifier = new GoogleOidcVerifier(fetchKeys, clock);
    expect(await verifier.verify(token('k1', k1.privateKey), EXPECTED)).toBe(true);

    now += HOUR + 1;
    expect(await verifier.verify(token('k1', k1.privateKey), EXPECTED)).toBe(true);
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it('throws, for a 5xx, when no key for the token can be had', async () => {
    const fetchKeys = jest.fn().mockRejectedValue(new Error('Google signing keys: 503'));
    const verifier = new GoogleOidcVerifier(fetchKeys, clock);
    await expect(verifier.verify(token('k1', k1.privateKey), EXPECTED)).rejects.toThrow('503');
    // Within the minute, no new fetch, and still not a 401.
    now += 1_000;
    await expect(verifier.verify(token('k1', k1.privateKey), EXPECTED)).rejects.toThrow();
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it('checks expiry against the injected clock, not the real time (#1456)', async () => {
    const verifier = new GoogleOidcVerifier(async () => [jwk(k1.publicKey, 'k1')], clock);
    const exp = T0 + 10 * HOUR;
    // Allowed until 60 s of clock skew past exp, whatever the real date is.
    now = exp + 59_000;
    expect(await verifier.verify(token('k1', k1.privateKey), EXPECTED)).toBe(true);
    now = exp + 60_000;
    expect(await verifier.verify(token('k1', k1.privateKey), EXPECTED)).toBe(false);
  });

  it('rejects a token whose kid names a key that is not RSA, without throwing', async () => {
    const verifier = new GoogleOidcVerifier(async () => [{ kty: 'oct', kid: 'k1', k: 'c2VjcmV0LWtleS1ieXRlcw' }], clock);
    expect(await verifier.verify(token('k1', k1.privateKey), EXPECTED)).toBe(false);
  });
});
