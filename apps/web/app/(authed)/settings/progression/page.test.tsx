import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchUserSettings: jest.fn(),
}));

// Stub the client form so the test isolates the page's data-fetch fallback. It echoes the
// default it was given so we can assert what the page passed down.
jest.mock('./DefaultProgressionForm', () => ({
  __esModule: true,
  default: ({ initialDefault }: { initialDefault: unknown }) => (
    <div data-default={JSON.stringify(initialDefault)}>default-progression-form</div>
  ),
}));

import { fetchUserSettings } from '@/lib/api';
import ProgressionPage from './page';

const mockedFetch = fetchUserSettings as unknown as jest.Mock;

describe('ProgressionPage — fetch fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the form with the fetched default on success', async () => {
    mockedFetch.mockResolvedValue({
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: null,
      unit: null,
      defaultProgression: { type: 'linear', increment: 5, repsLow: null, repsHigh: 5 },
    });
    const html = renderToStaticMarkup((await ProgressionPage()) as ReactElement);
    // Data-level assertion: the real fetched default reached the form.
    expect(html).toContain('&quot;type&quot;:&quot;linear&quot;');
  });

  it('falls back to no default (no throw) when the API is unreachable', async () => {
    mockedFetch.mockRejectedValue(new Error('API down'));
    const html = renderToStaticMarkup((await ProgressionPage()) as ReactElement);
    expect(html).toContain('default-progression-form');
    expect(html).toContain('data-default="null"');
  });
});
