import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchCustomPrograms: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn(),
}));

jest.mock('@/lib/active-program', () => ({
  getUserSettings: jest.fn(),
}));

// Stub the wizard so the test isolates the page's own fetch/fallback logic —
// echo the received props so assertions can inspect exactly what the page
// passed down, matching the OnboardingPage test's established pattern.
jest.mock('./ImportWizard', () => ({
  ImportWizard: ({
    programs,
    programsLoadFailed,
    customLifts,
    unit,
  }: {
    programs: unknown[];
    programsLoadFailed: boolean;
    customLifts: unknown[];
    unit: unknown;
  }) => (
    <div
      data-programs={JSON.stringify(programs)}
      data-programs-load-failed={String(programsLoadFailed)}
      data-custom-lifts={JSON.stringify(customLifts)}
      data-unit={JSON.stringify(unit)}
    >
      import-wizard
    </div>
  ),
}));

import { fetchCustomPrograms, fetchCustomLifts } from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import { getUserSettings } from '@/lib/active-program';
import { PROGRAMS } from '@/lib/programs';
import ImportPage from './page';

const mockedFetchPrograms = fetchCustomPrograms as unknown as jest.Mock;
const mockedFetchCustomLifts = fetchCustomLifts as unknown as jest.Mock;
const mockedGetPreferredUnit = getPreferredUnit as unknown as jest.Mock;
const mockedGetUserSettings = getUserSettings as unknown as jest.Mock;

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

async function renderedPrograms(): Promise<{ id: string; name: string; isTemplate?: boolean }[]> {
  const html = renderToStaticMarkup((await ImportPage()) as ReactElement);
  const encoded = html.match(/data-programs="([^"]*)"/)?.[1];
  if (encoded === undefined) throw new Error('data-programs attribute not found');
  return JSON.parse(encoded.replace(/&quot;/g, '"'));
}

async function programsLoadFailed(): Promise<string | undefined> {
  const html = renderToStaticMarkup((await ImportPage()) as ReactElement);
  return html.match(/data-programs-load-failed="([^"]*)"/)?.[1];
}

describe('ImportPage — where a user can import to (#1115)', () => {
  const OTHER_ID = '11111111-1111-1111-1111-111111111111';
  const OTHER = { ...PROGRAM, id: OTHER_ID, name: 'Other Program' };
  const RPT_NAME = PROGRAMS.find((p) => p.id === 'rpt')?.name;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetPreferredUnit.mockResolvedValue('lbs');
    mockedFetchCustomLifts.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('offers the active template to a user with no custom program', async () => {
    mockedFetchPrograms.mockResolvedValue([]);
    mockedGetUserSettings.mockResolvedValue({ activeProgram: 'rpt' });

    expect(RPT_NAME).toBeTruthy();
    expect(await renderedPrograms()).toEqual([{ id: 'rpt', name: RPT_NAME, isTemplate: true }]);
  });

  it('puts the active template ahead of custom programs', async () => {
    mockedFetchPrograms.mockResolvedValue([PROGRAM]);
    mockedGetUserSettings.mockResolvedValue({ activeProgram: '5-3-1' });

    expect((await renderedPrograms()).map((p) => p.id)).toEqual(['5-3-1', 'prog-1']);
  });

  it('puts an active custom program first and adds no template', async () => {
    mockedFetchPrograms.mockResolvedValue([PROGRAM, OTHER]);
    mockedGetUserSettings.mockResolvedValue({ activeProgram: OTHER_ID });

    expect((await renderedPrograms()).map((p) => p.id)).toEqual([OTHER_ID, 'prog-1']);
  });

  it('adds nothing for an account with no active program, so it gets the guidance instead', async () => {
    mockedFetchPrograms.mockResolvedValue([]);
    mockedGetUserSettings.mockResolvedValue({ activeProgram: null });

    expect(await renderedPrograms()).toEqual([]);
  });

  it('names a template the catalog does not list by its slug', async () => {
    mockedFetchPrograms.mockResolvedValue([]);
    mockedGetUserSettings.mockResolvedValue({ activeProgram: '5-3-1' });

    expect(await renderedPrograms()).toEqual([{ id: '5-3-1', name: '5-3-1', isTemplate: true }]);
  });

  it('does not offer an active custom program missing from the list as a template', async () => {
    mockedFetchPrograms.mockResolvedValue([PROGRAM]);
    mockedGetUserSettings.mockResolvedValue({ activeProgram: 'e6d3e12d-bf4d-4618-a0ae-6194ff13ba8a' });

    expect((await renderedPrograms()).map((p) => p.id)).toEqual(['prog-1']);
  });

  it('keeps custom programs and logs when the settings fetch fails', async () => {
    mockedFetchPrograms.mockResolvedValue([PROGRAM]);
    mockedGetUserSettings.mockRejectedValue(new Error('API down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect((await renderedPrograms()).map((p) => p.id)).toEqual(['prog-1']);
    expect(errSpy).toHaveBeenCalledWith(
      'ImportPage: user settings fetch failed, omitting active program',
      expect.any(Error),
    );
    expect(await programsLoadFailed()).toBe('true');
  });

  it('still offers the active template when the custom programs fetch fails', async () => {
    mockedFetchPrograms.mockRejectedValue(new Error('API down'));
    mockedGetUserSettings.mockResolvedValue({ activeProgram: '5-3-1' });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    expect((await renderedPrograms()).map((p) => p.id)).toEqual(['5-3-1']);
    expect(await programsLoadFailed()).toBe('true');
  });

  it('does not report a load failure when both fetches succeed', async () => {
    mockedFetchPrograms.mockResolvedValue([]);
    mockedGetUserSettings.mockResolvedValue({ activeProgram: null });

    expect(await programsLoadFailed()).toBe('false');
  });
});

describe('ImportPage — custom programs / custom lifts fetch (#911)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetPreferredUnit.mockResolvedValue('lbs');
    mockedGetUserSettings.mockResolvedValue({ activeProgram: null });
  });

  // #911 review, eighth pass: jest.clearAllMocks() (above) resets call
  // history but does NOT restore a jest.spyOn(console, 'error') mock — three
  // tests below each spy on console.error and only undo it with their own
  // errSpy.mockRestore() at the end, so any assertion failing before that
  // line would leave console.error permanently mocked for every later test in
  // this file (the exact hazard already fixed in ImportWizard.test.tsx's own
  // afterEach, not carried over when this file was added in the same PR).
  // jest.restoreAllMocks() here covers it unconditionally, regardless of
  // where a test exits.
  afterEach(() => {
    jest.restoreAllMocks();
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
