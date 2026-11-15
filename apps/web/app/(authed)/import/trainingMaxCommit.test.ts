import {
  buildTrainingMaxPreview,
  classifyAndCount,
  latestTrainingMaxFirst,
  parseCsvText,
  parseTrainingMaxes,
  trainingMaxRowKind,
  type TrainingMax,
} from '@lifting-logbook/core';
import type { ImportPreview } from '@lifting-logbook/types';
import { buildTrainingMaxesCsv, type EditableMax } from './trainingMaxCommit';

// Round trips a file the way the wizard does: the server previews the file, Review lists its
// create and update rows, and the commit sends the rebuilt file, which the server classifies
// and writes. The core functions below are the ones the API runs for both (#1128).

const TODAY = '2026-11-15';

const FILE = [
  'Date Updated,Lift,Weight',
  '9/28/2026,squat,300',
  '9/27/2026,bench,200',
  '9/1/2026,squat,280',
].join('\n');

const parse = (csv: string) => parseTrainingMaxes(parseCsvText(csv));
const preview = (csv: string, stored: TrainingMax[]) => buildTrainingMaxPreview(parse(csv), stored, new Map());
const counts = (p: ImportPreview) => ({ creates: p.creates, updates: p.updates, skips: p.skips });

// What enterReview lists.
function reviewList(p: ImportPreview): EditableMax[] {
  return p.deltas
    .filter((d) => d.kind === 'create' || d.kind === 'update')
    .map((d) => ({ lift: d.key, label: d.label, weight: d.after ?? '', date: d.date }));
}

function rebuild(p: ImportPreview, review = reviewList(p), excluded: ReadonlySet<string> = new Set()) {
  return buildTrainingMaxesCsv(review, p.deltas, excluded, TODAY);
}

// Commits a file the way the API's adapters do, returning the stored maxes.
async function commit(csv: string, before: TrainingMax[] = []): Promise<TrainingMax[]> {
  const weightOf = new Map(before.map((m) => [m.lift, m.weight]));
  const byLift = new Map(before.map((m) => [m.lift, m]));
  await classifyAndCount(
    latestTrainingMaxFirst(parse(csv)),
    (m) => m.lift,
    (m) => trainingMaxRowKind(m, weightOf),
    (m) => {
      byLift.set(m.lift, m);
    },
  );
  return [...byLift.values()];
}

const dayOf = (m: TrainingMax | undefined) => m?.dateUpdated.toISOString().slice(0, 10);

describe('buildTrainingMaxesCsv (#1128)', () => {
  it('commits with the counts the preview showed, an older row of a lift counted as skipped', () => {
    const first = preview(FILE, []);
    expect(counts(first)).toEqual({ creates: 2, updates: 0, skips: 1 });

    expect(counts(preview(rebuild(first), []))).toEqual(counts(first));
  });

  it('keeps the newest row of a lift as its max', async () => {
    const maxes = await commit(rebuild(preview(FILE, [])));
    expect(maxes.find((m) => m.lift === 'squat')?.weight).toBe(300);
  });

  it('reports every row as skipped when the same file is imported again', async () => {
    const afterFirst = await commit(rebuild(preview(FILE, [])));
    const second = preview(FILE, afterFirst);
    expect(counts(second)).toEqual({ creates: 0, updates: 0, skips: 3 });

    expect(counts(preview(rebuild(second), afterFirst))).toEqual({ creates: 0, updates: 0, skips: 3 });
  });

  it("neither writes nor counts a removed row, nor its lift's older rows", async () => {
    const first = preview(FILE, []);
    const csv = rebuild(first, reviewList(first), new Set(['squat']));

    expect(counts(preview(csv, []))).toEqual({ creates: 1, updates: 0, skips: 0 });
    expect((await commit(csv)).map((m) => m.lift)).toEqual(['bench']);
  });

  it("stores each max with the file's date", async () => {
    const maxes = await commit(rebuild(preview(FILE, [])));
    expect(dayOf(maxes.find((m) => m.lift === 'squat'))).toBe('2026-09-28');
    expect(dayOf(maxes.find((m) => m.lift === 'bench'))).toBe('2026-09-27');
  });

  it('dates an edited max today, and still keeps it over an older row of the lift', async () => {
    const first = preview(FILE, []);
    const review = reviewList(first).map((r) => (r.lift === 'squat' ? { ...r, weight: '310', date: undefined } : r));
    const maxes = await commit(rebuild(first, review));

    const squat = maxes.find((m) => m.lift === 'squat');
    expect(squat?.weight).toBe(310);
    expect(dayOf(squat)).toBe(TODAY);
    expect(dayOf(maxes.find((m) => m.lift === 'bench'))).toBe('2026-09-27');
  });

  it('keeps an edited max over an older row dated after today', async () => {
    const future = ['Date Updated,Lift,Weight', '12/30/2026,squat,300', '12/29/2026,squat,280'].join('\n');
    const first = preview(future, []);
    const review = reviewList(first).map((r) => ({ ...r, weight: '310', date: undefined }));

    expect((await commit(rebuild(first, review))).find((m) => m.lift === 'squat')?.weight).toBe(310);
  });

  it('dates rows today for an API that sends no dates', async () => {
    const first = preview(FILE, []);
    const undated = { ...first, deltas: first.deltas.map(({ date: _date, ...d }) => d) };
    const maxes = await commit(rebuild(undated));

    expect(maxes.find((m) => m.lift === 'squat')?.weight).toBe(300);
    expect(dayOf(maxes.find((m) => m.lift === 'squat'))).toBe(TODAY);
  });
});
