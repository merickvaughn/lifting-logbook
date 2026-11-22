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
  default: ({ imports }: { imports: unknown }) => <div data-imports={JSON.stringify(imports)}>training-max-imports</div>,
}));

import { fetchTrainingMaxImportBatches } from '@/lib/api';
import TrainingMaxesPage from './page';

const mockedFetchImports = fetchTrainingMaxImportBatches as unknown as jest.Mock;
const NOTICE = 'Undoing a training-max import isn’t available right now';

describe('TrainingMaxesPage — training-max imports (#1405)', () => {
  beforeEach(() => mockedFetchImports.mockReset());

  it("passes the active program's training-max imports to the Undo list", async () => {
    mockedFetchImports.mockResolvedValue([{ id: 'tm-1', program: '5-3-1', createdAt: '2026-11-21T18:04:09.000Z' }]);
    const html = renderToStaticMarkup((await TrainingMaxesPage()) as ReactElement);
    expect(mockedFetchImports).toHaveBeenCalledWith('5-3-1');
    // Data-level assertion: the fetched batch reached the list.
    expect(html).toContain('tm-1');
    expect(html).not.toContain(NOTICE);
  });

  it("still renders the page, with a notice and no Undo, when the imports can't be read", async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedFetchImports.mockRejectedValue(new Error('API down'));
    const html = renderToStaticMarkup((await TrainingMaxesPage()) as ReactElement);
    expect(html).toContain('data-imports="[]"');
    expect(html).toContain(NOTICE);
    expect(error).toHaveBeenCalledWith(
      '[TrainingMaxesPage] training-max imports fetch failed, showing no Undo',
      expect.any(Error),
    );
    error.mockRestore();
  });
});
