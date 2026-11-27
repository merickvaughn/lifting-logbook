import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('@/lib/api', () => ({
  fetchCustomPrograms: jest.fn(),
  fetchRecordedPrograms: jest.fn(),
  // Read through the real lib/active-program, as the page reads it.
  fetchUserSettings: jest.fn(),
}));
jest.mock('./DownloadAll', () => ({ __esModule: true, default: () => <div data-download-all /> }));
jest.mock('./GoogleSheet', () => ({
  __esModule: true,
  default: ({ notice }: { notice?: string }) => <div data-google-sheet={notice ?? ''} />,
}));
jest.mock('./TrainingData', () => ({ __esModule: true, default: () => <div data-training-data /> }));
jest.mock('./SetsExport', () => ({
  __esModule: true,
  default: ({ programs }: { programs: unknown }) => <div data-programs={JSON.stringify(programs)} />,
}));

import { fetchCustomPrograms, fetchRecordedPrograms, fetchUserSettings } from '@/lib/api';
import DataSettingsPage from './page';

const custom = { id: '0b5e4c1e-3f43-4a0e-9a8c-1d2e3f405162', name: 'My plan' };

async function renderPrograms(): Promise<{ id: string; name: string }[]> {
  const html = renderToStaticMarkup((await DataSettingsPage()) as ReactElement);
  expect(html).toContain('data-download-all');
  expect(html).toContain('data-training-data');
  const encoded = html.match(/data-programs="([^"]*)"/)?.[1];
  if (encoded === undefined) throw new Error('data-programs attribute not found in rendered output');
  return JSON.parse(encoded.replace(/&quot;/g, '"')) as { id: string; name: string }[];
}

describe('Settings → Data page', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    (fetchRecordedPrograms as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => consoleError.mockRestore());

  it('offers the active template and the custom programs to the sets filter', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '5-3-1' });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([custom]);

    expect((await renderPrograms()).map((p) => p.id)).toEqual(['5-3-1', custom.id]);
  });

  // #1454: an import can go into a template the lifter can't pick, and its sets must still export.
  it('offers a template that holds the lifter’s sets, though it’s neither active nor available', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: 'rpt' });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([custom]);
    (fetchRecordedPrograms as jest.Mock).mockResolvedValue(['531', 'rpt']);

    expect(await renderPrograms()).toEqual([
      { id: 'rpt', name: 'Reverse Pyramid Training (Lyle/Eric Helms)', isTemplate: true },
      custom,
      { id: '531', name: '5/3/1', isTemplate: true },
    ]);
  });

  // #1355: switching to a program writes a macrocycle, so asking for macrocycle programs would
  // offer a template the lifter tried but logged nothing in.
  it('asks for the programs holding sets only, not those holding just macrocycles', async () => {
    await renderPrograms();

    expect(fetchRecordedPrograms).toHaveBeenCalledWith({});
  });

  it('still offers the active and custom programs when the recorded programs can’t be read', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '5-3-1' });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([custom]);
    (fetchRecordedPrograms as jest.Mock).mockRejectedValue(new Error('recorded down'));

    expect((await renderPrograms()).map((p) => p.id)).toEqual(['5-3-1', custom.id]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('recorded programs fetch failed'), expect.any(Error));
  });

  // #1465: a deleted custom program's sets stay under its id, so they must still export.
  it('offers a deleted custom program that holds the lifter’s sets, named as deleted', async () => {
    const deleted = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '5-3-1' });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([custom]);
    (fetchRecordedPrograms as jest.Mock).mockResolvedValue(['5-3-1', custom.id, deleted]);

    expect(await renderPrograms()).toEqual([
      { id: '5-3-1', name: '5-3-1', isTemplate: true },
      custom,
      { id: deleted, name: 'Deleted program (7d1e2f30)' },
    ]);
  });

  // #1465: with the custom programs unread, a recorded custom id can't be told apart from a deleted one.
  it('doesn’t call a recorded custom program deleted when the custom programs can’t be read', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '5-3-1' });
    (fetchCustomPrograms as jest.Mock).mockRejectedValue(new Error('custom down'));
    (fetchRecordedPrograms as jest.Mock).mockResolvedValue(['5-3-1', custom.id]);

    expect((await renderPrograms()).map((p) => p.id)).toEqual(['5-3-1']);
  });

  it('still offers the custom programs when settings can’t be read', async () => {
    (fetchUserSettings as jest.Mock).mockRejectedValue(new Error('settings down'));
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([custom]);

    expect((await renderPrograms()).map((p) => p.id)).toEqual([custom.id]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('user settings fetch failed'), expect.any(Error));
  });

  it('still offers the active program when the custom programs can’t be read', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '5-3-1' });
    (fetchCustomPrograms as jest.Mock).mockRejectedValue(new Error('customs down'));

    expect((await renderPrograms()).map((p) => p.id)).toEqual(['5-3-1']);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('custom programs fetch failed'), expect.any(Error));
  });

  it('shows the Google Sheet section, with the callback’s result when it sent one', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '5-3-1' });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([]);

    expect(renderToStaticMarkup((await DataSettingsPage()) as ReactElement)).toContain('data-google-sheet=""');
    const withNotice = await DataSettingsPage({ searchParams: Promise.resolve({ google_sheet: 'denied' }) });
    expect(renderToStaticMarkup(withNotice as ReactElement)).toContain('data-google-sheet="denied"');
    // A value the route never sends is ignored, so the query can't put text on the page.
    const forged = await DataSettingsPage({ searchParams: Promise.resolve({ google_sheet: 'hello' }) });
    expect(renderToStaticMarkup(forged as ReactElement)).toContain('data-google-sheet=""');
  });
});
