import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EncryptedToken } from '../ports/IGoogleSheetLinkRepository';

/** Wraps and unwraps data keys with google-oauth-token-kek (ADR-047, decision 8). */
export interface IKeyWrapper {
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrappedKey: Buffer): Promise<Buffer>;
}

/** "google_sheet_link:" || userId, so a ciphertext moved to another user's row fails (decision 7). */
const aad = (userId: string) => Buffer.from(`google_sheet_link:${userId}`, 'utf8');
const TAG_BYTES = 16;

/**
 * ADR-014's envelope encryption: a fresh 32-byte data key and 12-byte nonce per write, AES-256-GCM,
 * and the data key wrapped by KMS. The ciphertext stores the GCM tag after the encrypted bytes.
 * The plaintext data key is zeroed once used, as ADR-014 asks.
 */
export class TokenCipher {
  constructor(private readonly keys: IKeyWrapper) {}

  async encrypt(userId: string, token: string): Promise<EncryptedToken> {
    const dataKey = randomBytes(32);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
      cipher.setAAD(aad(userId));
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return { ciphertext, wrappedKey: await this.keys.wrap(dataKey), nonce };
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(userId: string, encrypted: EncryptedToken): Promise<string> {
    const dataKey = await this.keys.unwrap(encrypted.wrappedKey);
    try {
      const decipher = createDecipheriv('aes-256-gcm', dataKey, encrypted.nonce);
      decipher.setAAD(aad(userId));
      const end = encrypted.ciphertext.length - TAG_BYTES;
      decipher.setAuthTag(encrypted.ciphertext.subarray(end));
      return Buffer.concat([decipher.update(encrypted.ciphertext.subarray(0, end)), decipher.final()]).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }
}

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
// Decision 21's 20 s per Google call, for the metadata server and KMS too.
const TIMEOUT_MS = 20_000;

/**
 * Cloud KMS over REST, authenticated as the service's own account through the metadata server,
 * so no client library is needed. `keyName` is the crypto key's resource name.
 */
export class CloudKmsKeyWrapper implements IKeyWrapper {
  constructor(private readonly keyName: string) {}

  private async request(op: 'encrypt' | 'decrypt', field: string, value: Buffer): Promise<Buffer> {
    if (!this.keyName) throw new Error(`KMS ${op}: no key name set`);
    const tokenRes = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!tokenRes.ok) throw new Error(`KMS ${op}: metadata token ${tokenRes.status}`);
    const { access_token } = (await tokenRes.json()) as { access_token?: unknown };
    if (typeof access_token !== 'string' || !access_token) throw new Error(`KMS ${op}: metadata token missing`);
    const res = await fetch(`https://cloudkms.googleapis.com/v1/${this.keyName}:${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ [field]: value.toString('base64') }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The status only: the body could echo the request.
    if (!res.ok) throw new Error(`KMS ${op}: ${res.status}`);
    const out = op === 'encrypt' ? 'ciphertext' : 'plaintext';
    const encoded = ((await res.json()) as Record<string, unknown>)[out];
    // An empty key would encrypt (or decrypt) with nothing a later call could recover.
    if (typeof encoded !== 'string' || !encoded) throw new Error(`KMS ${op}: response has no ${out}`);
    return Buffer.from(encoded, 'base64');
  }

  wrap(dataKey: Buffer): Promise<Buffer> {
    return this.request('encrypt', 'plaintext', dataKey);
  }

  unwrap(wrappedKey: Buffer): Promise<Buffer> {
    return this.request('decrypt', 'ciphertext', wrappedKey);
  }
}
