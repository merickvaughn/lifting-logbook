import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchCustomPrograms: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn(),
}));

// Stub the wizard so the test isolates the page's own fetch/fallback logic —
// echo the received props so assertions can inspect exactly what the page
// passed down, matching the OnboardingPage test's established pattern.
jest.mock('./ImportWizard', () => ({
  ImportWizard: ({
    programs,
    customLifts,
    unit,
  }: {
    programs: unknown[];
    customLifts: unknown[];
    unit: unknown;
  }) => (
    <div
      data-programs={JSON.stringify(programs)}
      data-custom-lifts={JSON.stringify(customLifts)}
      data-unit={JSON.stringify(unit)}
    >
      import-wizard
    </div>
  ),
}));

import { fetchCustomPrograms, fetchCustomLifts } from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import ImportPage from './page';

const mockedFetchPrograms = fetchCustomPrograms as unknown as jest.Mock;
const mockedFetchCustomLifts = fetchCustomLifts as unknown as jest.Mock;
const mockedGetPreferredUnit = getPreferredUnit as unknown as jest.Mock;

const PROGRAM = { id: 'prog-1', name: 'My Program', description: null, baseTemplate: null, createdAt: '2026-01-01' };
const CUSTOM_LIFT = {
  id: 'custom-1',
  name: 'Wide-Grip CBL Curls',
  classification: 'accessory',
  movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
  isBodyweightComponent: false,
  isCustom: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ImportPage — custom programs / custom lifts fetch (#911)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetPreferredUnit.mockResolvedValue('lbs');
  });

  it('passes the fetched programs and custom lifts to the wizard on success', async () => {
    mockedFetchPrograms.mockResolvedValue([PROGRAM]);
    mockedFetchCustomLifts.mockResolvedValue([CUSTOM_LIFT]);

    const element = (await ImportPage()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).toContain('import-wizard');
    expect(html).toContain('My Program');
    expect(html).toContain('Wide-Grip CBL Curls');
  });

  it('falls back to an empty custom-lifts list and logs when fetchCustomLifts fails', async () => {
    mockedFetchPrograms.mockResolvedValue([PROGRAM]);
    mockedFetchCustomLifts.mockRejectedValue(new Error('API down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const element = (await ImportPage()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).toContain('import-wizard');
    expect(html).toContain('My Program');
    const encoded = html.match(/data-custom-lifts="([^"]*)"/)?.[1];
    if (encoded === undefined) throw new Error('data-custom-lifts attribute not found');
    expect(JSON.parse(encoded.replace(/&quot;/g, '"'))).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(
      'ImportPage: custom lifts fetch failed, rendering empty list',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('falls back to an empty programs list and logs when fetchCustomPrograms fails, independent of the custom-lifts fetch', async () => {
    mockedFetchPrograms.mockRejectedValue(new Error('API down'));
    mockedFetchCustomLifts.mockResolvedValue([CUSTOM_LIFT]);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const element = (await ImportPage()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).toContain('import-wizard');
    // The programs fetch failing must not affect the independently-fetched
    // custom lifts (the two run concurrently, not one gated on the other).
    expect(html).toContain('Wide-Grip CBL Curls');
    const encoded = html.match(/data-programs="([^"]*)"/)?.[1];
    if (encoded === undefined) throw new Error('data-programs attribute not found');
    expect(JSON.parse(encoded.replace(/&quot;/g, '"'))).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(
      'ImportPage: custom programs fetch failed, rendering empty picker',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  // #911 review, third pass: getPreferredUnit() is documented never to throw,
  // so this branch is unreachable in production today — but this page now
  // uses a genuine Promise.allSettled specifically so a rejection here can
  // never crash the whole Server Component if that contract ever changes.
  // Previously (a bare Promise.all with getPreferredUnit left unwrapped) this
  // path had no way to be exercised at all: any rejection would reject the
  // whole Promise.all and throw out of the component before this branch could
  // run.
  it('falls back to the default weight unit and logs when getPreferredUnit fails, independent of the other two fetches', async () => {
    mockedFetchPrograms.mockResolvedValue([PROGRAM]);
    mockedFetchCustomLifts.mockResolvedValue([CUSTOM_LIFT]);
    mockedGetPreferredUnit.mockRejectedValue(new Error('settings API down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const element = (await ImportPage()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).toContain('import-wizard');
    // The unit fetch failing must not affect the independently-fetched
    // programs/custom lifts.
    expect(html).toContain('My Program');
    expect(html).toContain('Wide-Grip CBL Curls');
    const encoded = html.match(/data-unit="([^"]*)"/)?.[1];
    if (encoded === undefined) throw new Error('data-unit attribute not found');
    expect(JSON.parse(encoded.replace(/&quot;/g, '"'))).toBe('lbs');
    expect(errSpy).toHaveBeenCalledWith(
      'ImportPage: preferred-unit fetch failed, defaulting',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
