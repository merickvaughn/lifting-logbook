import { InMemoryGoogleSheetLinkRepository } from './google-sheet-link.adapter';

/** The in-memory mirror lease (#1443, ADR-047 decision 19) behaves as the Prisma repository's does. */
describe('InMemoryGoogleSheetLinkRepository mirror lease', () => {
  const T0 = Date.parse('2026-11-23T12:00:00Z');
  let now = T0;
  let repo: InMemoryGoogleSheetLinkRepository;

  beforeEach(async () => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    repo = new InMemoryGoogleSheetLinkRepository();
    await repo.saveLink({
      status: 'linked',
      spreadsheetId: 's',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/s/edit',
      grantedScope: 'g',
      token: { ciphertext: Buffer.from('ct'), wrappedKey: Buffer.from('wk'), nonce: Buffer.alloc(12, 1) },
      lastErrorCode: null,
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('is held for five minutes, then can be taken again', async () => {
    expect(await repo.takeMirrorLease('s')).toEqual({ spreadsheetId: 's', until: new Date(T0 + 5 * 60_000) });
    now = T0 + 5 * 60_000 - 1;
    expect(await repo.takeMirrorLease('s')).toBeNull();
    now = T0 + 5 * 60_000 + 1;
    expect(await repo.takeMirrorLease('s')).not.toBeNull();
  });

  it('is not taken on a link to another sheet', async () => {
    expect(await repo.takeMirrorLease('other')).toBeNull();
  });

  it("releases and records only the run's own lease, and never lowers the seq", async () => {
    const first = await repo.takeMirrorLease('s');
    if (!first) throw new Error('no lease');
    now = T0 + 6 * 60_000;
    const second = await repo.takeMirrorLease('s');
    if (!second) throw new Error('no lease');

    await repo.releaseMirrorLease(first, 'google_503');
    expect(await repo.recordMirrored(first, 9)).toBe(false);
    expect(await repo.getLink()).toMatchObject({ lastErrorCode: null, lastMirroredSeq: null });
    expect(await repo.takeMirrorLease('s')).toBeNull();

    expect(await repo.recordMirrored(second, 9)).toBe(true);
    const third = await repo.takeMirrorLease('s');
    if (!third) throw new Error('no lease');
    expect(await repo.recordMirrored(third, 4)).toBe(true);
    expect(await repo.getLink()).toMatchObject({ lastMirroredSeq: 9 });
  });
});
