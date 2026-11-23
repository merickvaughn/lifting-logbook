import { createPublicKey, verify, webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey & { kid?: string };

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const KEYS_TIMEOUT_MS = 5_000;
const KEYS_TTL_MS = 60 * 60_000;
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

  constructor(private readonly fetchKeys: FetchKeys = fetchGoogleKeys) {}

  private async keyFor(kid: string): Promise<JsonWebKey | undefined> {
    const stale = Date.now() - this.fetchedAt > KEYS_TTL_MS;
    if (stale || !this.keys.some((k) => k.kid === kid)) {
      this.keys = await this.fetchKeys();
      this.fetchedAt = Date.now();
    }
    return this.keys.find((k) => k.kid === kid);
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
    if (!jwk) return false;
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!signed) return false;

    const now = Date.now() / 1000;
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
