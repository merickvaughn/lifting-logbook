// Real-Postgres E2E for the supplement sheet mirror's trigger (#1444, ADR-047 decisions 16, 22).
// `app` boots against the restricted lifting_app role, so a supplement write runs through
// RlsInterceptor's transaction, the real PrismaRepositoryFactory and forced row-level security;
// `owner` only seeds and cleans up. The queue is a fake, so nothing leaves the process.
//
// What this proves that the in-memory suite can't: the link read runs inside the write's own RLS
// transaction, as the writer, and the enqueue happens once that transaction has committed.
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { PrismaGoogleSheetLinkRepository } from '../adapters/prisma/google-sheet-link.repository';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { AppModule } from '../app.module';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { ISheetMirrorQueue, MirrorTaskKind, SHEET_MIRROR_QUEUE } from './sheet-mirror-queue';

// See programs.db.e2e.spec.ts (#567): headroom for a contended full-suite Windows run.
const DB_E2E_HOOK_TIMEOUT_MS = 30_000;

const APP_ROLE_URL = process.env.LIFTING_TC_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.LIFTING_TC_OWNER_DATABASE_URL;
const describeOrSkip = APP_ROLE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
// Only read inside the guarded describe, so the '' fallback never runs (as in rls.db.e2e.spec.ts).
const OWNER_URL = OWNER_DATABASE_URL ?? '';

const PREFIX = `db-e2e-mirror-trigger-${process.pid}-`;
const LINKED = `${PREFIX}linked`;
const OTHER = `${PREFIX}other`;
const UNLINKED = `${PREFIX}unlinked`;
const TODAY = '2026-11-23';

const linkRow = (userId: string) => ({
  userId,
  status: 'linked' as const,
  spreadsheetId: `${userId}-sheet`,
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${userId}-sheet/edit`,
  grantedScope: 'https://www.googleapis.com/auth/drive.file',
  refreshTokenCiphertext: Buffer.from('ct'),
  refreshTokenDekCiphertext: Buffer.from('wk'),
  refreshTokenNonce: Buffer.alloc(12, 1),
});

class FakeQueue implements ISheetMirrorQueue {
  enqueued: { userId: string; kind: MirrorTaskKind }[] = [];
  async enqueue(userId: string, _now?: Date, kind: MirrorTaskKind = 'change') {
    this.enqueued.push({ userId, kind });
  }
}

async function clean(owner: PrismaClient): Promise<void> {
  const where = { userId: { startsWith: PREFIX } };
  // Doses and mix parts cascade from their item.
  await owner.supplementItem.deleteMany({ where });
  await owner.supplementDayType.deleteMany({ where });
  await owner.supplementChange.deleteMany({ where });
  await owner.userSettings.deleteMany({ where });
  await owner.googleSheetLink.deleteMany({ where });
}

describeOrSkip('Supplement sheet mirror trigger (e2e, real Postgres, lifting_app role)', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  const queue = new FakeQueue();
  /** Each link read: the user RLS saw it run as, and what it returned. */
  let reads: { rlsUser: string | null | undefined; spreadsheetId: string | undefined }[];

  const addItem = (user: string, name: string) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/supplements/items?today=${TODAY}`,
        headers: { authorization: `Bearer ${user}` },
        payload: { name, doses: [{ slot: 'am', amount: '1 scoop', servings: 1, dayTypes: [] }] },
      });

  beforeAll(async () => {
    // Allowed by jest.env.setup.js Proxy because value === LIFTING_TC_DATABASE_URL.
    process.env.DATABASE_URL = APP_ROLE_URL;
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await clean(owner);
    await owner.googleSheetLink.create({ data: linkRow(LINKED) });
    await owner.googleSheetLink.create({ data: linkRow(OTHER) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SHEET_MIRROR_QUEUE)
      .useValue(queue)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
    await clean(owner).catch(() => undefined);
    await owner?.$disconnect();
  }, DB_E2E_HOOK_TIMEOUT_MS);

  beforeEach(() => {
    queue.enqueued = [];
    reads = [];
    const original = PrismaGoogleSheetLinkRepository.prototype.getLink;
    jest.spyOn(PrismaGoogleSheetLinkRepository.prototype, 'getLink').mockImplementation(async function (this: PrismaGoogleSheetLinkRepository) {
      const link = await original.call(this);
      // The same client the read used: the write's transaction, with the GUC RLS policies key on.
      const client = (this as unknown as { prisma: PrismaClient }).prisma;
      const [row] = await client.$queryRaw<Array<{ uid: string | null }>>`SELECT current_setting('app.current_user_id', true) AS uid`;
      reads.push({ rlsUser: row?.uid, spreadsheetId: link?.spreadsheetId });
      return link;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs as the restricted role, not the owner', async () => {
    const rows = await app.get(PrismaService, { strict: false }).$queryRaw<
      Array<{ role: string; rolbypassrls: boolean }>
    >`SELECT current_user::text AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ role: 'lifting_app', rolbypassrls: false }]);
  });

  it("enqueues a linked user's write before the response, reading only that user's link as that user", async () => {
    const res = await addItem(LINKED, 'Creatine');

    expect(res.statusCode).toBe(201);
    expect(queue.enqueued).toEqual([{ userId: LINKED, kind: 'change' }]);
    expect(reads).toEqual([{ rlsUser: LINKED, spreadsheetId: `${LINKED}-sheet` }]);
  });

  it("never reads another user's link: an unlinked user's write sees no link and enqueues nothing", async () => {
    const res = await addItem(UNLINKED, 'Magnesium');

    expect(res.statusCode).toBe(201);
    // No row came back: the link read saw neither LINKED's nor OTHER's row.
    expect(reads).toStrictEqual([{ rlsUser: UNLINKED, spreadsheetId: undefined }]);
    expect(queue.enqueued).toEqual([]);
  });

  it('enqueues nothing for a refused write, whose transaction rolls back', async () => {
    const res = await addItem(LINKED, '');

    expect(res.statusCode).toBe(400);
    expect(queue.enqueued).toEqual([]);
  });
});
