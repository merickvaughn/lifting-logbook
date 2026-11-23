import { TokenCipher } from './token-cipher';
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
});
