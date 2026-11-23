// Real-Postgres E2E for the Google Sheet link tables (#1432, ADR-047). `appDb` connects as the
// restricted lifting_app role, so forced row-level security applies; `owner` only seeds and cleans.
import { Prisma, PrismaClient } from '@prisma/client';
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
const record = (spreadsheetId = 's') => ({
  status: 'linked' as const,
  spreadsheetId,
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  grantedScope: 'g',
  token: token(),
  lastErrorCode: null,
});
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
      await repo.saveLink(record());
      expect(await repo.getLink()).toMatchObject({ status: 'linked', token: token(), lastErrorCode: null });
      await repo.putOauthRequest({ stateHash: Buffer.alloc(32, 3), codeVerifier: 'v', expiresAt: new Date() });
      expect(await repo.takeOauthRequest()).toMatchObject({ codeVerifier: 'v' });
      expect(await repo.takeOauthRequest()).toBeNull();
      await repo.deleteLink();
      expect(await repo.getLink()).toBeNull();
    });
  });

  it('records the error code with the status (decision 11)', async () => {
    await asUser(USER_A, async (repo) => {
      await repo.saveLink(record());
      await repo.saveLink({ ...record(), status: 'needs_relink', token: null, lastErrorCode: 'invalid_grant' });
      expect(await repo.getLink()).toMatchObject({ status: 'needs_relink', token: null, lastErrorCode: 'invalid_grant' });
    });
    expect(await owner.googleSheetLink.findUnique({ where: { userId: USER_A } })).toMatchObject({ lastErrorCode: 'invalid_grant' });
    await owner.googleSheetLink.deleteMany({ where: { userId: USER_A } });
  });

  it("keeps the mirror's history for the same spreadsheet and starts it over for a new one", async () => {
    await asUser(USER_A, (repo) => repo.saveLink(record('first')));
    const mirrored = { lastMirroredAt: new Date('2026-11-01T00:00:00Z'), lastMirroredSeq: 7, mirrorLeaseUntil: new Date('2026-11-01T00:01:00Z') };
    await owner.googleSheetLink.update({ where: { userId: USER_A }, data: mirrored });

    await asUser(USER_A, (repo) => repo.saveLink(record('first')));
    expect(await owner.googleSheetLink.findUnique({ where: { userId: USER_A } })).toMatchObject(mirrored);

    await asUser(USER_A, (repo) => repo.saveLink(record('second')));
    expect(await owner.googleSheetLink.findUnique({ where: { userId: USER_A } })).toMatchObject({
      spreadsheetId: 'second',
      lastMirroredAt: null,
      lastMirroredSeq: null,
      mirrorLeaseUntil: null,
    });
    await owner.googleSheetLink.deleteMany({ where: { userId: USER_A } });
  });

  describe('the mirror lease and run record (#1443, decision 19)', () => {
    const SHEET = 'lease-sheet';
    const stored = () => owner.googleSheetLink.findUnique({ where: { userId: USER_A } });
    const take = () => asUser(USER_A, (repo) => repo.takeMirrorLease(SHEET));
    const lease = async () => {
      const taken = await take();
      if (!taken) throw new Error('lease not taken');
      return taken;
    };

    beforeEach(async () => {
      await owner.googleSheetLink.deleteMany({ where: { userId: USER_A } });
      await asUser(USER_A, (repo) => repo.saveLink(record(SHEET)));
    });
    afterAll(async () => {
      await owner.googleSheetLink.deleteMany({ where: { userId: USER_A } });
    });

    it("is taken once, for five minutes by the database's clock, and stored as returned", async () => {
      const [{ dbNow }] = await owner.$queryRaw<[{ dbNow: Date }]>`SELECT timezone('UTC', now()) AS "dbNow"`;
      const taken = await lease();
      expect(Math.abs(taken.until.getTime() - (dbNow.getTime() + 5 * 60_000))).toBeLessThan(10_000);
      expect((await stored())?.mirrorLeaseUntil).toEqual(taken.until);
      expect(await take()).toBeNull();
    });

    it('can be taken once it has expired', async () => {
      await lease();
      await owner.googleSheetLink.update({ where: { userId: USER_A }, data: { mirrorLeaseUntil: new Date(Date.now() - 60 * 60_000) } });
      expect(await take()).not.toBeNull();
    });

    it("is released by its own run, and not by a run whose lease another run took", async () => {
      const first = await lease();
      await asUser(USER_A, (repo) => repo.releaseMirrorLease(first, 'google_503'));
      expect(await stored()).toMatchObject({ mirrorLeaseUntil: null, lastErrorCode: 'google_503' });

      const stale = await lease();
      await owner.googleSheetLink.update({ where: { userId: USER_A }, data: { mirrorLeaseUntil: new Date(Date.now() - 60 * 60_000) } });
      const current = await lease();
      await asUser(USER_A, (repo) => repo.releaseMirrorLease(stale, 'google_500'));
      expect(await asUser(USER_A, (repo) => repo.recordMirrored(stale, 3))).toBe(false);
      expect(await stored()).toMatchObject({ mirrorLeaseUntil: current.until, lastErrorCode: 'google_503', lastMirroredSeq: null });
    });

    it('records the seq and when, and never lowers the seq', async () => {
      const taken = await lease();
      expect(await asUser(USER_A, (repo) => repo.recordMirrored(taken, 7))).toBe(true);
      expect(await stored()).toMatchObject({ lastMirroredSeq: 7, lastErrorCode: null, mirrorLeaseUntil: null });
      expect((await stored())?.lastMirroredAt).toBeInstanceOf(Date);
      expect(await asUser(USER_A, (repo) => repo.getLink())).toMatchObject({ lastMirroredSeq: 7 });

      const lower = await lease();
      expect(await asUser(USER_A, (repo) => repo.recordMirrored(lower, 4))).toBe(true);
      expect(await stored()).toMatchObject({ lastMirroredSeq: 7, mirrorLeaseUntil: null });
    });

    it('marks needs_relink or sheet_missing without creating a row', async () => {
      await owner.googleSheetLink.deleteMany({ where: { userId: USER_A } });
      await asUser(USER_A, async (repo) => {
        await repo.markNeedsRelink(SHEET, token().nonce);
        await repo.markSheetMissing(SHEET);
        await repo.releaseMirrorLease({ spreadsheetId: SHEET, until: new Date() }, 'google_503');
      });
      expect(await stored()).toBeNull();
    });

    it('marks only the link to the same sheet, and needs_relink only while it holds the same token', async () => {
      await asUser(USER_A, async (repo) => {
        await repo.markNeedsRelink('another-sheet', token().nonce);
        await repo.markSheetMissing('another-sheet');
        await repo.markNeedsRelink(SHEET, Buffer.alloc(12, 9));
      });
      expect(await stored()).toMatchObject({ status: 'linked', lastErrorCode: null, refreshTokenNonce: token().nonce });

      await asUser(USER_A, (repo) => repo.markNeedsRelink(SHEET, token().nonce));
      expect(await stored()).toMatchObject({
        status: 'needs_relink',
        lastErrorCode: 'invalid_grant',
        refreshTokenCiphertext: null,
        refreshTokenDekCiphertext: null,
        refreshTokenNonce: null,
      });
      // sheet_missing needs a token, so a needs_relink row is left alone rather than failing the check.
      await asUser(USER_A, (repo) => repo.markSheetMissing(SHEET));
      expect(await stored()).toMatchObject({ status: 'needs_relink' });
    });

    it("doesn't touch another user's row", async () => {
      const sheetB = link(USER_B).spreadsheetId;
      await asUser(USER_A, async (repo) => {
        expect(await repo.takeMirrorLease(sheetB)).toBeNull();
        await repo.markNeedsRelink(sheetB, link(USER_B).refreshTokenNonce);
        await repo.markSheetMissing(sheetB);
        await repo.releaseMirrorLease({ spreadsheetId: sheetB, until: new Date() }, 'google_503');
      });
      expect(await owner.googleSheetLink.findUnique({ where: { userId: USER_B } })).toMatchObject({
        status: 'linked',
        lastErrorCode: null,
        mirrorLeaseUntil: null,
        lastMirroredSeq: null,
      });
    });
  });

  it('gives a state to only one of two callbacks taking it at once (decision 5)', async () => {
    await asUser(USER_A, (repo) =>
      repo.putOauthRequest({ stateHash: Buffer.alloc(32, 4), codeVerifier: 'once', expiresAt: new Date(Date.now() + 600_000) }),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstTook!: () => void;
    const taken = new Promise<void>((resolve) => (firstTook = resolve));
    // The first holds its delete uncommitted while the second reads the row and waits on its lock.
    const first = asUser(USER_A, async (repo) => {
      const request = await repo.takeOauthRequest();
      firstTook();
      await held;
      return request;
    });
    await taken;
    const second = asUser(USER_A, (repo) => repo.takeOauthRequest());
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r?.codeVerifier ?? null)).toEqual(['once', null]);
  });

  it('rejects a linked row with no ciphertext, and a needs_relink row with one, as lifting_app', async () => {
    const insert = (data: Prisma.GoogleSheetLinkUncheckedCreateInput) =>
      asUser(USER_A, (_repo, tx) => tx.googleSheetLink.create({ data }));
    await expect(
      insert({ ...link(USER_A), refreshTokenCiphertext: null, refreshTokenDekCiphertext: null, refreshTokenNonce: null }),
    ).rejects.toThrow(/google_sheet_link_token_check/);
    await expect(insert({ ...link(USER_A), status: 'needs_relink' })).rejects.toThrow(/google_sheet_link_token_check/);
    await expect(insert({ ...link(USER_A), refreshTokenNonce: null })).rejects.toThrow(/google_sheet_link_token_check/);
    await asUser(USER_A, (repo) => repo.saveLink({ ...record(), status: 'needs_relink', token: null, lastErrorCode: 'invalid_grant' }));
    expect(await owner.googleSheetLink.count({ where: { userId: USER_A, status: 'needs_relink' } })).toBe(1);
    await owner.googleSheetLink.deleteMany({ where: { userId: USER_A } });
  });
});
