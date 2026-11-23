import { CloudKmsKeyWrapper, IKeyWrapper, TokenCipher } from './token-cipher';
import { FAKE_REFRESH_TOKEN, FakeKeyWrapper } from './fakes';

describe('TokenCipher (ADR-047, decision 7)', () => {
  const cipher = new TokenCipher(new FakeKeyWrapper());

  it('round-trips a token for the same user, storing no plaintext', async () => {
    const encrypted = await cipher.encrypt('user-a', FAKE_REFRESH_TOKEN);
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.ciphertext.toString('utf8')).not.toContain(FAKE_REFRESH_TOKEN);
    expect(await cipher.decrypt('user-a', encrypted)).toBe(FAKE_REFRESH_TOKEN);
  });

  it("fails to decrypt a ciphertext moved to another user's row", async () => {
    const encrypted = await cipher.encrypt('user-a', FAKE_REFRESH_TOKEN);
    await expect(cipher.decrypt('user-b', encrypted)).rejects.toThrow();
  });

  it('uses a fresh data key and nonce for every write', async () => {
    const [one, two] = [await cipher.encrypt('user-a', 't'), await cipher.encrypt('user-a', 't')];
    expect(one.nonce.equals(two.nonce)).toBe(false);
    expect(one.wrappedKey.equals(two.wrappedKey)).toBe(false);
  });

  it('zeroes the plaintext data key after encrypting and after decrypting (ADR-014)', async () => {
    const fake = new FakeKeyWrapper();
    const seen: Buffer[] = [];
    const keys: IKeyWrapper = {
      wrap: async (dataKey) => (seen.push(dataKey), fake.wrap(dataKey)),
      unwrap: async (wrapped) => {
        const dataKey = await fake.unwrap(wrapped);
        seen.push(dataKey);
        return dataKey;
      },
    };
    const zeroing = new TokenCipher(keys);
    expect(await zeroing.decrypt('user-a', await zeroing.encrypt('user-a', FAKE_REFRESH_TOKEN))).toBe(FAKE_REFRESH_TOKEN);
    expect(seen).toHaveLength(2);
    for (const key of seen) expect(key.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe('CloudKmsKeyWrapper', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  const respond = (body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

  it('gives the metadata server and KMS a timeout each', async () => {
    respond({ access_token: 'at' });
    respond({ ciphertext: Buffer.from('wrapped').toString('base64') });
    expect((await new CloudKmsKeyWrapper('projects/p/keys/k').wrap(Buffer.alloc(32))).toString()).toBe('wrapped');
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails rather than return an empty key when KMS omits the field', async () => {
    respond({ access_token: 'at' });
    respond({});
    await expect(new CloudKmsKeyWrapper('projects/p/keys/k').unwrap(Buffer.from('w'))).rejects.toThrow('KMS decrypt: response has no plaintext');
    respond({ access_token: 'at' });
    respond({ ciphertext: '' });
    await expect(new CloudKmsKeyWrapper('projects/p/keys/k').wrap(Buffer.alloc(32))).rejects.toThrow('KMS encrypt: response has no ciphertext');
  });

  it('fails without a call when no key name is set', async () => {
    await expect(new CloudKmsKeyWrapper('').wrap(Buffer.alloc(32))).rejects.toThrow('no key name set');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
