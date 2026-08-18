import { classifyAndCount, classifyImportRows } from './classifyAndCount';
import { ImportRowKind } from './buildImportPreview';

type Row = { k: string };

describe('classifyImportRows', () => {
  it('yields each unique row with its key and classification', () => {
    const kindOf = (k: string): ImportRowKind =>
      k === 'a' ? 'create' : k === 'b' ? 'update' : 'skip';

    const out = [
      ...classifyImportRows<Row>([{ k: 'a' }, { k: 'b' }, { k: 'c' }], (r) => r.k, (r) =>
        kindOf(r.k),
      ),
    ];

    expect(out).toEqual([
      { row: { k: 'a' }, kind: 'create', key: 'a' },
      { row: { k: 'b' }, kind: 'update', key: 'b' },
      { row: { k: 'c' }, kind: 'skip', key: 'c' },
    ]);
  });

  it('yields a duplicate key within the batch as a skip (first occurrence wins the classification)', () => {
    const seen: Array<{ k: string }> = [];
    const out = [
      ...classifyImportRows<Row>(
        [{ k: 'x' }, { k: 'x' }, { k: 'y' }],
        (r) => r.k,
        (r) => {
          seen.push(r);
          return 'create';
        },
      ),
    ];

    // The duplicate 'x' IS yielded (issue #884: previously dropped with zero
    // trace), but as an unconditional 'skip' — the classifier is not
    // re-invoked for it, since the first occurrence already decided.
    expect(out).toEqual([
      { row: { k: 'x' }, kind: 'create', key: 'x' },
      { row: { k: 'x' }, kind: 'skip', key: 'x' },
      { row: { k: 'y' }, kind: 'create', key: 'y' },
    ]);
    expect(seen).toEqual([{ k: 'x' }, { k: 'y' }]);
  });

  it('passes the deduped key to the classifier so it need not recompute it', () => {
    const keysSeenByClassifier: string[] = [];
    const consumed = [
      ...classifyImportRows<Row>(
        [{ k: 'p' }, { k: 'q' }],
        (r) => `key:${r.k}`,
        (_r, key) => {
          keysSeenByClassifier.push(key);
          return 'create';
        },
      ),
    ];

    expect(consumed.map((c) => c.key)).toEqual(['key:p', 'key:q']);
    expect(keysSeenByClassifier).toEqual(['key:p', 'key:q']);
  });
});

describe('classifyAndCount', () => {
  it('tallies create/update/skip and writes only the non-skip rows', async () => {
    const kindOf = (k: string): ImportRowKind =>
      k === 'a' ? 'create' : k === 'b' ? 'update' : 'skip';
    const writes: Array<[string, string]> = [];

    const result = await classifyAndCount<Row>(
      [{ k: 'a' }, { k: 'b' }, { k: 'c' }],
      (r) => r.k,
      (r) => kindOf(r.k),
      (r, kind) => {
        writes.push([r.k, kind]);
      },
    );

    expect(result).toEqual({ created: 1, updated: 1, skipped: 1 });
    // 'create' and 'update' written (with their kind); 'skip' not written.
    expect(writes).toEqual([
      ['a', 'create'],
      ['b', 'update'],
    ]);
  });

  it('counts a duplicate key within the batch as skipped (first occurrence wins the write)', async () => {
    const writes: string[] = [];

    const result = await classifyAndCount<Row>(
      [{ k: 'x' }, { k: 'x' }, { k: 'y' }],
      (r) => r.k,
      () => 'create',
      (r) => {
        writes.push(r.k);
      },
    );

    // Issue #884: the duplicate 'x' is now counted as skipped rather than
    // vanishing untallied. It is still not re-written.
    expect(result).toEqual({ created: 2, updated: 0, skipped: 1 });
    expect(writes).toEqual(['x', 'y']);
  });

  it('never invokes applyWrite for a skipped row', async () => {
    const applyWrite = jest.fn();

    const result = await classifyAndCount<Row>(
      [{ k: 'a' }, { k: 'b' }],
      (r) => r.k,
      () => 'skip',
      applyWrite,
    );

    expect(result).toEqual({ created: 0, updated: 0, skipped: 2 });
    expect(applyWrite).not.toHaveBeenCalled();
  });

  it('awaits each write and propagates a mid-batch failure without advancing counts', async () => {
    const writes: string[] = [];

    await expect(
      classifyAndCount<Row>(
        [{ k: 'a' }, { k: 'b' }, { k: 'c' }],
        (r) => r.k,
        () => 'create',
        async (r) => {
          if (r.k === 'b') throw new Error('boom');
          writes.push(r.k);
        },
      ),
    ).rejects.toThrow('boom');

    // Stopped at the failing row — 'c' was never reached. A caller running this
    // inside a transaction rolls the whole batch back.
    expect(writes).toEqual(['a']);
  });
});
