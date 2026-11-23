import { ingredientTotals, stackAsOf, totalOf } from '@src/core';
import type { SupplementChange } from '@lifting-logbook/types';
import { changeLog, dose, ing, item } from './supplementFixtures';

const ids = (log: readonly SupplementChange[], date: string) => stackAsOf(log, date).stack.map((i) => i.id);

describe('stackAsOf', () => {
  const a = item('a');
  const log = changeLog(
    { date: '2026-01-01', type: 'added', item: a },
    { date: '2026-01-03', type: 'removed', item: a },
    { date: '2026-01-05', type: 'restored', itemId: 'a' },
  );
  it('is absent while removed and present once restored', () => {
    expect(ids(log, '2026-01-02')).toEqual(['a']);
    expect(ids(log, '2026-01-04')).toEqual([]);
    expect(ids(log, '2026-01-05')).toEqual(['a']);
    expect(stackAsOf(log, '2026-01-05').anomalies).toEqual([]);
  });
  it('replays the day types as they were on the date, through a rename and a delete', () => {
    const l = changeLog(
      { date: '2026-01-01', type: 'day_types_set', dayTypes: [{ id: 'lift', name: 'Lift day' }, { id: 'rest', name: 'Rest day' }] },
      { date: '2026-01-05', type: 'day_types_set', dayTypes: [{ id: 'lift', name: 'Push day' }] },
    );
    expect(stackAsOf(l, '2025-12-31').dayTypes).toEqual([]);
    expect(stackAsOf(l, '2026-01-04').dayTypes.map((d) => d.name)).toEqual(['Lift day', 'Rest day']);
    expect(stackAsOf(l, '2026-01-05').dayTypes).toEqual([{ id: 'lift', name: 'Push day' }]);
  });
  it('applies edits, moves, pending, started and confirmed', () => {
    const l = changeLog(
      { date: '2026-01-01', type: 'added', item: item('a', { unverified: true }) },
      { date: '2026-01-02', type: 'edited', itemId: 'a', changes: { name: 'New' } },
      { date: '2026-01-02', type: 'moved', itemId: 'a', doses: [dose({ slot: 'post' })] },
      { date: '2026-01-02', type: 'moved_to_pending', itemId: 'a' },
      { date: '2026-01-03', type: 'started', itemId: 'a' },
      { date: '2026-01-03', type: 'confirmed', itemId: 'a' },
    );
    expect(stackAsOf(l, '2026-01-02').stack[0]).toMatchObject({ name: 'New', status: 'pending', unverified: true });
    const end = stackAsOf(l, '2026-01-03').stack[0];
    expect(end).toMatchObject({ status: 'active', unverified: false });
    expect(end?.doses[0]?.slot).toBe('post');
  });
  it('orders by date regardless of log order', () => {
    expect(ids([...log].reverse(), '2026-01-04')).toEqual([]);
  });
  it('orders same-day changes by seq, not by position in the log', () => {
    const sameDay = changeLog(
      { date: '2026-01-01', type: 'added', item: a },
      { date: '2026-01-02', type: 'removed', item: a },
      { date: '2026-01-02', type: 'restored', itemId: 'a' },
    );
    expect(ids(sameDay, '2026-01-02')).toEqual(['a']);
    expect(ids([...sameDay].reverse(), '2026-01-02')).toEqual(['a']);
  });
  it('rejects a date that is not YYYY-MM-DD rather than dropping same-day changes', () => {
    expect(() => stackAsOf(log, '2026-01-05T10:00Z')).toThrow(RangeError);
    const timestamped = changeLog({ date: '2026-01-05T10:00Z', type: 'added', item: a });
    expect(() => stackAsOf(timestamped, '2026-01-05')).toThrow(RangeError);
  });

  describe('anomalies', () => {
    it('reports changes that name an item the log never added', () => {
      const l = changeLog(
        { date: '2026-01-01', type: 'started', itemId: 'ghost' },
        { date: '2026-01-01', type: 'restored', itemId: 'ghost' },
        { date: '2026-01-01', type: 'folded_into_mix', mixId: 'nomix', itemId: 'ghost' },
      );
      const r = stackAsOf(l, '2026-01-01');
      expect(r.stack).toEqual([]);
      expect(r.anomalies.map((x) => [x.change.seq, x.itemId, x.reason])).toEqual([
        [0, 'ghost', 'unknown-item'],
        [1, 'ghost', 'unknown-item'],
        [2, 'nomix', 'unknown-item'],
        [2, 'ghost', 'unknown-item'],
      ]);
    });
    it('ignores re-adding a folded item, so the mix is not counted twice', () => {
      const salt = item('salt', { ingredients: [ing('sodium', 500)] });
      const l = changeLog(
        { date: '2026-01-01', type: 'added', item: salt },
        { date: '2026-01-02', type: 'mix_created', mix: item('mix'), partIds: ['salt'] },
        { date: '2026-01-03', type: 'added', item: salt },
        { date: '2026-01-03', type: 'restored', itemId: 'salt' },
      );
      const r = stackAsOf(l, '2026-01-03');
      expect(r.stack.map((i) => i.id)).toEqual(['mix']);
      expect(totalOf(ingredientTotals(r.stack, 'lift'), 'sodium', 'mg')).toBe(500);
      expect(r.anomalies.map((x) => [x.change.type, x.reason])).toEqual([
        ['added', 'folded-item'],
        ['restored', 'folded-item'],
      ]);
    });
  });

  describe('mixes', () => {
    const na = item('na', { ingredients: [ing('sodium', 5)] });
    const k = item('k', { ingredients: [ing('potassium', 7)] });
    const cl = item('cl', { ingredients: [ing('chloride', 9)] });

    it('hides parts folded into a mix, and records which item each part came from', () => {
      const l = changeLog(
        { date: '2026-01-01', type: 'added', item: na },
        { date: '2026-01-01', type: 'added', item: k },
        { date: '2026-01-01', type: 'added', item: cl },
        { date: '2026-01-02', type: 'mix_created', mix: item('mix'), partIds: ['na', 'k'] },
        { date: '2026-01-03', type: 'folded_into_mix', mixId: 'mix', itemId: 'cl' },
        { date: '2026-01-04', type: 'restored', itemId: 'na' },
      );
      expect(ids(l, '2026-01-01')).toEqual(['na', 'k', 'cl']);
      // The mix takes its first part's place, as the API puts it (applyChange).
      expect(ids(l, '2026-01-02')).toEqual(['mix', 'cl']);
      const end = stackAsOf(l, '2026-01-04').stack;
      expect(end.map((i) => i.id)).toEqual(['mix']);
      expect(end[0]?.parts?.map((p) => [p.itemId, p.name])).toEqual([
        ['na', 'na'],
        ['k', 'k'],
        ['cl', 'cl'],
      ]);
    });
    it('keeps a mix its own ingredients when none of its parts resolve', () => {
      const l = changeLog({
        date: '2026-01-01',
        type: 'mix_created',
        mix: item('mix', { ingredients: [ing('caffeine', 100)] }),
        partIds: ['ghost'],
      });
      const r = stackAsOf(l, '2026-01-01');
      expect(r.stack[0]?.parts).toBeUndefined();
      expect(totalOf(ingredientTotals(r.stack, 'lift'), 'caffeine', 'mg')).toBe(100);
      expect(r.anomalies.map((x) => [x.itemId, x.reason])).toEqual([['ghost', 'unknown-item']]);
    });
    it('keeps a plain item its own ingredients when another is folded into it', () => {
      const l = changeLog(
        { date: '2026-01-01', type: 'added', item: item('pre', { ingredients: [ing('caffeine', 200)] }) },
        { date: '2026-01-01', type: 'added', item: na },
        { date: '2026-01-02', type: 'folded_into_mix', mixId: 'pre', itemId: 'na' },
      );
      const t = ingredientTotals(stackAsOf(l, '2026-01-02').stack, 'lift');
      expect(totalOf(t, 'caffeine', 'mg')).toBe(200);
      expect(totalOf(t, 'sodium', 'mg')).toBe(5);
    });

    describe('mix_split', () => {
      it('brings the parts back and drops a mix made from them', () => {
        const l = changeLog(
          { date: '2026-01-01', type: 'added', item: na },
          { date: '2026-01-01', type: 'added', item: k },
          { date: '2026-01-02', type: 'mix_created', mix: item('mix'), partIds: ['na', 'k'] },
          { date: '2026-01-03', type: 'mix_split', mixId: 'mix' },
          { date: '2026-01-04', type: 'restored', itemId: 'mix' },
        );
        expect(ids(l, '2026-01-02')).toEqual(['mix']);
        const r = stackAsOf(l, '2026-01-04');
        expect(r.stack.map((i) => i.id)).toEqual(['na', 'k']);
        expect(r.anomalies.map((x) => [x.change.type, x.itemId, x.reason])).toEqual([
          ['restored', 'mix', 'unknown-item'],
        ]);
      });
      it('turns an item that had others folded in back into itself', () => {
        const pre = item('pre', { ingredients: [ing('caffeine', 200)] });
        const l = changeLog(
          { date: '2026-01-01', type: 'added', item: pre },
          { date: '2026-01-01', type: 'added', item: na },
          { date: '2026-01-02', type: 'folded_into_mix', mixId: 'pre', itemId: 'na' },
          { date: '2026-01-03', type: 'mix_split', mixId: 'pre' },
        );
        const r = stackAsOf(l, '2026-01-03');
        expect(r.stack).toEqual([pre, na]);
        expect(r.anomalies).toEqual([]);
      });
      it('reports splitting an item that is not a mix, and a part it cannot bring back', () => {
        const l = changeLog(
          { date: '2026-01-01', type: 'added', item: na },
          { date: '2026-01-01', type: 'mix_split', mixId: 'na' },
          {
            date: '2026-01-01',
            type: 'added',
            item: item('premade', { parts: [{ itemId: 'never', name: 'never', ingredients: [] }] }),
          },
          { date: '2026-01-01', type: 'mix_split', mixId: 'premade' },
        );
        const r = stackAsOf(l, '2026-01-01');
        expect(r.stack.map((i) => i.id)).toEqual(['na']);
        expect(r.anomalies.map((x) => [x.itemId, x.reason])).toEqual([
          ['na', 'not-a-mix'],
          ['never', 'unknown-item'],
        ]);
      });
    });
  });
});
