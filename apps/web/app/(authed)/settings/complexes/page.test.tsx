import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchBarbellComplexes: jest.fn().mockResolvedValue([]),
  fetchCustomLifts: jest.fn(),
}));

// Echo what the page passes down.
jest.mock('./ComplexesEditor', () => ({
  __esModule: true,
  default: ({ customLiftNames }: { customLiftNames: string[] }) => (
    <div data-custom-lifts={JSON.stringify(customLiftNames)}>complexes-editor</div>
  ),
}));

import { fetchCustomLifts } from '@/lib/api';
import ComplexesPage from './page';

const mockedFetchCustomLifts = fetchCustomLifts as unknown as jest.Mock;

describe('ComplexesPage (#1495)', () => {
  beforeEach(() => mockedFetchCustomLifts.mockReset());

  it('offers the lifter’s own lifts by name', async () => {
    mockedFetchCustomLifts.mockResolvedValue([{ id: 'custom-1', name: 'Hang Clean' }]);
    const html = renderToStaticMarkup((await ComplexesPage()) as ReactElement);
    expect(html).toContain('data-custom-lifts="[&quot;Hang Clean&quot;]"');
  });

  it('still renders, offering catalog lifts only, when custom lifts can’t be read', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedFetchCustomLifts.mockRejectedValue(new Error('API down'));
    const html = renderToStaticMarkup((await ComplexesPage()) as ReactElement);
    expect(html).toContain('data-custom-lifts="[]"');
    expect(error).toHaveBeenCalledWith(
      '[ComplexesPage] custom lifts fetch failed, offering catalog lifts only',
      expect.any(Error),
    );
    error.mockRestore();
  });
});
