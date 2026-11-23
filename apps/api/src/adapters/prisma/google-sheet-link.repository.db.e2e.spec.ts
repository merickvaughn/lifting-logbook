// Real-Postgres E2E for the Google Sheet link tables (#1432, ADR-047). `appDb` connects as the
// restricted lifting_app role, so forced row-level security applies; `owner` only seeds and cleans.
import { PrismaClient } from '@prisma/client';
import { PrismaGoogleSheetLinkRepository } from './google-sheet-link.repository';

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_TC_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_TC_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallbacks never run (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_TC_URL ?? '';
const APP_DB_URL = APP_ROLE_URL ?? '';
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const USER_A = 'db-e2e-gsheet-a';
const USER_B = 'db-e2e-gsheet-b';
const USERS = [USER_A, USER_B];

const token = () => ({ ciphertext: Buffer.from('ct'), wrappedKey: Buffer.from('wk'), nonce: Buffer.alloc(12, 1) });
const link = (userId: string) => ({
  userId,
  status: 'linked' as const,
  spreadsheetId: `${userId}-sheet`,
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${userId}-sheet/edit`,
  grantedScope: 'https://www.googleapis.com/auth/drive.file',
  refreshTokenCiphertext: Buffer.from('ct'),
  refreshTokenDekCiphertext: Buffer.from('wk'),
  refreshTokenNonce: Buffer.alloc(12, 1),
});

describeOrSkip('PrismaGoogleSheetLinkRepository (e2e, lifting_app role)', () => {
  let owner: PrismaClient;
  let appDb: PrismaClient;

  const asUser = <T>(userId: string, body: (repo: PrismaGoogleSheetLinkRepository, tx: PrismaClient) => Promise<T>) =>
    appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return body(new PrismaGoogleSheetLinkRepository(tx, userId), tx as unknown as PrismaClient);
    });

  const clean = async () => {
    await owner.googleSheetLink.deleteMany({ where: { userId: { in: USERS } } });
    await owner.googleOauthRequest.deleteMany({ where: { userId: { in: USERS } } });
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    appDb = new PrismaClient({ datasources: { db: { url: APP_DB_URL } } });
    await clean();
    await owner.googleSheetLink.create({ data: link(USER_B) });
    await owner.googleOauthRequest.create({
      data: { userId: USER_B, stateHash: Buffer.alloc(32, 2), codeVerifier: 'verifier-b', expiresAt: new Date(Date.now() + 600_000) },
    });
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await clean().catch(() => undefined);
    await owner?.$disconnect();
    await appDb?.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  it('runs as the restricted role', async () => {
    const rows = await appDb.$queryRaw<Array<{ rolbypassrls: boolean }>>`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ rolbypassrls: false }]);
  });

  it("can't read another user's link or OAuth request", async () => {
    await asUser(USER_A, async (repo, tx) => {
      expect(await repo.getLink()).toBeNull();
      expect(await tx.googleSheetLink.findMany({ where: { userId: USER_B } })).toEqual([]);
      expect(await tx.googleOauthRequest.findMany({ where: { userId: USER_B } })).toEqual([]);
      // Nor delete them.
      expect((await tx.googleSheetLink.deleteMany({ where: { userId: USER_B } })).count).toBe(0);
      expect((await tx.googleOauthRequest.deleteMany({ where: { userId: USER_B } })).count).toBe(0);
    });
    expect(await owner.googleSheetLink.count({ where: { userId: USER_B } })).toBe(1);
    expect(await owner.googleOauthRequest.count({ where: { userId: USER_B } })).toBe(1);
  });

  it("can't write a row for another user", async () => {
    await expect(asUser(USER_A, (_repo, tx) => tx.googleSheetLink.create({ data: link('db-e2e-gsheet-other') }))).rejects.toThrow();
  });

  it('stores, reads and deletes its own link and request', async () => {
    await asUser(USER_A, async (repo) => {
      await repo.saveLink({ status: 'linked', spreadsheetId: 's', spreadsheetUrl: 'u', grantedScope: 'g', token: token() });
      expect(await repo.getLink()).toMatchObject({ status: 'linked', token: token() });
      await repo.putOauthRequest({ stateHash: Buffer.alloc(32, 3), codeVerifier: 'v', expiresAt: new Date() });
      expect(await repo.takeOauthRequest()).toMatchObject({ codeVerifier: 'v' });
      expect(await repo.takeOauthRequest()).toBeNull();
      await repo.deleteLink();
      expect(await repo.getLink()).toBeNull();
    });
  });

  it('rejects a linked row with no ciphertext, and a needs_relink row with one', async () => {
    await expect(
      owner.googleSheetLink.create({
        data: { ...link(USER_A), refreshTokenCiphertext: null, refreshTokenDekCiphertext: null, refreshTokenNonce: null },
      }),
    ).rejects.toThrow(/google_sheet_link_token_check/);
    await expect(owner.googleSheetLink.create({ data: { ...link(USER_A), status: 'needs_relink' } })).rejects.toThrow(
      /google_sheet_link_token_check/,
    );
    await expect(owner.googleSheetLink.create({ data: { ...link(USER_A), refreshTokenNonce: null } })).rejects.toThrow(
      /google_sheet_link_token_check/,
    );
    await asUser(USER_A, (repo) =>
      repo.saveLink({ status: 'needs_relink', spreadsheetId: 's', spreadsheetUrl: 'u', grantedScope: 'g', token: null }),
    );
    expect(await owner.googleSheetLink.count({ where: { userId: USER_A, status: 'needs_relink' } })).toBe(1);
    await owner.googleSheetLink.deleteMany({ where: { userId: USER_A } });
  });
});
