import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchProgramSpec: jest.fn().mockResolvedValue([]),
  fetchTrainingMaxes: jest.fn().mockResolvedValue([]),
  fetchTrainingMaxHistory: jest.fn().mockResolvedValue({ entries: [] }),
  fetchTrainingMaxImportBatches: jest.fn(),
}));
jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
  getUserSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('@/lib/preferences', () => ({ getPreferredUnit: jest.fn().mockResolvedValue('lbs') }));

// Stub the client components so the test isolates what the page fetches and passes down.
jest.mock('./MissingTrainingMaxes', () => ({ __esModule: true, default: () => null }));
jest.mock('./TrainingMaxesForm', () => ({ __esModule: true, default: () => null }));
jest.mock('./MaxHistory', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/RepMaxCalculator', () => ({ __esModule: true, default: () => null }));
jest.mock('./TrainingMaxImports', () => ({
  __esModule: true,
  default: ({ imports, failed }: { imports: unknown; failed: boolean }) => (
    <div data-imports={JSON.stringify(imports)} data-failed={String(failed)}>
      training-max-imports
    </div>
  ),
}));

import { fetchTrainingMaxImportBatches } from '@/lib/api';
import MissingTrainingMaxes from './MissingTrainingMaxes';
import TrainingMaxesForm from './TrainingMaxesForm';
import MaxHistory from './MaxHistory';
import TrainingMaxesPage from './page';

const mockedFetchImports = fetchTrainingMaxImportBatches as unknown as jest.Mock;
const BATCH = { id: 'tm-1', program: '5-3-1', createdAt: '2026-11-21T18:04:09.000Z' };

describe('TrainingMaxesPage — training-max imports (#1405)', () => {
  beforeEach(() => mockedFetchImports.mockReset());

  it("passes the active program's training-max imports to the Undo list", async () => {
    mockedFetchImports.mockResolvedValue([BATCH]);
    const html = renderToStaticMarkup((await TrainingMaxesPage()) as ReactElement);
    expect(mockedFetchImports).toHaveBeenCalledWith('5-3-1');
    // Data-level assertion: the fetched batch reached the list.
    expect(html).toContain('tm-1');
    expect(html).toContain('data-failed="false"');
  });

  it("still renders the page, telling the list it failed, when the imports can't be read", async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedFetchImports.mockRejectedValue(new Error('API down'));
    const html = renderToStaticMarkup((await TrainingMaxesPage()) as ReactElement);
    expect(html).toContain('data-imports="[]"');
    expect(html).toContain('data-failed="true"');
    expect(error).toHaveBeenCalledWith(
      '[TrainingMaxesPage] training-max imports fetch failed, showing no Undo',
      expect.any(Error),
    );
    error.mockRestore();
  });

  // The form, history and missing-max prompt copy the maxes into state, so after an undo they must
  // remount, or the form's next Save writes the undone values back.
  it('keys the components that hold the maxes on the imports, so an undo remounts them', async () => {
    const holders = [MissingTrainingMaxes, TrainingMaxesForm, MaxHistory];
    // One key per holder, in the order above.
    const keysOf = async () => {
      const page = (await TrainingMaxesPage()) as ReactElement<{ children: ReactElement[] }>;
      return holders.map((holder) => page.props.children.find((c) => c.type === holder)?.key);
    };
    mockedFetchImports.mockResolvedValue([BATCH, { ...BATCH, id: 'tm-0' }]);
    const before = await keysOf();
    mockedFetchImports.mockResolvedValue([{ ...BATCH, id: 'tm-0' }]);
    const after = await keysOf();

    // Siblings sharing a key leave the old copy mounted beside the new one.
    expect(new Set(before).size).toBe(holders.length);
    before.forEach((key, i) => {
      expect(key).toEqual(expect.any(String));
      expect(after[i]).toEqual(expect.any(String));
      expect(after[i]).not.toBe(key);
    });
  });
});
