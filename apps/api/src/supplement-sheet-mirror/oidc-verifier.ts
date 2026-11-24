import { createPublicKey, verify, webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey & { kid?: string };

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const KEYS_TIMEOUT_MS = 5_000;
const KEYS_TTL_MS = 60 * 60_000;
/** The most often the keys are fetched again, whatever the requests ask for. */
const MIN_REFETCH_INTERVAL_MS = 60_000;
const CLOCK_SKEW_S = 60;

export type FetchKeys = () => Promise<JsonWebKey[]>;

/** Who may call the mirror endpoint (ADR-047, decision 18). Unset values reject every caller. */
export interface OidcExpectation {
  audience: string | undefined;
  email: string | undefined;
}

export interface IOidcVerifier {
  /** True only for a Google-signed token for this audience from this verified email. */
  verify(token: string | undefined, expected: OidcExpectation): Promise<boolean>;
}

export const fetchGoogleKeys: FetchKeys = async () => {
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(KEYS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Google signing keys: ${res.status}`);
  const { keys } = (await res.json()) as { keys?: JsonWebKey[] };
  return keys ?? [];
};

const decodeJson = (part: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    // A part that isn't base64url JSON is a malformed token, which is rejected.
    // fallback-covered-by: apps/api/src/supplement-sheet-mirror/supplement-sheet-mirror.e2e.spec.ts
    return null;
  }
};

/**
 * Verifies a Google-signed OIDC token with Node's crypto against Google's published signing
 * keys, so no client library is needed. A malformed or unsigned token returns false; failing to
 * fetch the keys throws, so the caller answers 5xx and Cloud Tasks retries.
 */
export class GoogleOidcVerifier implements IOidcVerifier {
  private keys: JsonWebKey[] = [];
  private fetchedAt = 0;
  /** When the last fetch started, whether it succeeded or not; 0 before the first. */
  private attemptedAt = 0;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly fetchKeys: FetchKeys = fetchGoogleKeys,
    private readonly clock: () => number = Date.now,
  ) {}

  /** One fetch at a time: concurrent callers share it. */
  private refresh(): Promise<void> {
    if (!this.inFlight) {
      this.attemptedAt = this.clock();
      this.inFlight = (async () => {
        this.keys = await this.fetchKeys();
        this.fetchedAt = this.clock();
      })().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /**
   * Fetches Google's keys when the cache is past its TTL or lacks `kid`, but at most once a
   * minute: the route is public, so an unknown `kid` must not turn every request into a fetch.
   * A failed refresh keeps the cached keys, and a token signed by one still verifies; it throws
   * only when it leaves no key for `kid`, so the caller answers 5xx and Cloud Tasks retries.
   */
  private async keyFor(kid: string): Promise<JsonWebKey | undefined> {
    const find = () => this.keys.find((k) => k.kid === kid);
    const now = this.clock();
    const due = now - this.fetchedAt > KEYS_TTL_MS || !find();
    const allowed = this.attemptedAt === 0 || now - this.attemptedAt >= MIN_REFETCH_INTERVAL_MS;
    if (due && (allowed || this.inFlight)) {
      try {
        await this.refresh();
      } catch (err) {
        // Stale keys still verify a token they signed; Google rotates keys over days, not minutes.
        // fallback-covered-by: apps/api/src/supplement-sheet-mirror/oidc-verifier.spec.ts
        if (!find()) throw err;
      }
    }
    // No key has ever been fetched: not the caller's fault, so the caller answers 5xx, not 401.
    if (this.fetchedAt === 0) throw new Error('Google signing keys have not been fetched');
    return find();
  }

  async verify(token: string | undefined, expected: OidcExpectation): Promise<boolean> {
    if (!token || !expected.audience || !expected.email) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart);
    const claims = decodeJson(payloadPart);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return false;

    const jwk = await this.keyFor(header.kid);
    // RS256 needs an RSA key; anything else in the set can't have signed this token.
    if (!jwk || jwk.kty !== 'RSA') return false;
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!signed) return false;

    const now = this.clock() / 1000;
    return (
      typeof claims.iss === 'string' &&
      ISSUERS.has(claims.iss) &&
      claims.aud === expected.audience &&
      typeof claims.exp === 'number' &&
      claims.exp + CLOCK_SKEW_S > now &&
      claims.email === expected.email &&
      claims.email_verified === true
    );
  }
}
