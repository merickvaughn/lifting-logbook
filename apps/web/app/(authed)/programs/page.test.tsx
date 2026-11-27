import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchUserSettings: jest.fn().mockResolvedValue({ activeProgram: null }),
  fetchCustomPrograms: jest.fn().mockResolvedValue([]),
  fetchBarbellComplexes: jest.fn(),
}));

// Echo the complexes the page passes down.
jest.mock('./ProgramsTabs', () => ({
  __esModule: true,
  default: ({ complexes }: { complexes: unknown }) => (
    <div data-complexes={JSON.stringify(complexes)}>programs-tabs</div>
  ),
}));

import { fetchBarbellComplexes } from '@/lib/api';
import ProgramsPage from './page';

const mockedComplexes = fetchBarbellComplexes as unknown as jest.Mock;

describe('ProgramsPage — the complexes (#1495)', () => {
  it('passes the lifter’s complexes down', async () => {
    mockedComplexes.mockResolvedValue([{ id: 'c-bear', name: 'Bear', components: [], createdAt: '2026-11-27' }]);
    const html = renderToStaticMarkup((await ProgramsPage()) as ReactElement);
    expect(html).toContain('&quot;name&quot;:&quot;Bear&quot;');
  });

  it('passes null, not an empty list, when they can’t be read, so a complex row isn’t called deleted', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedComplexes.mockRejectedValue(new Error('API down'));
    const html = renderToStaticMarkup((await ProgramsPage()) as ReactElement);
    expect(html).toContain('data-complexes="null"');
    expect(error).toHaveBeenCalledWith('[ProgramsPage] complexes fetch failed, the editor offers lifts only', expect.any(Error));
    error.mockRestore();
  });
});
