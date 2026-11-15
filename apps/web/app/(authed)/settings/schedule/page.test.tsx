import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchUserSettings: jest.fn(),
}));

// Stub the client form so the test isolates the page's data-fetch fallback.
// It echoes the resolved schedule so we can assert what the page passed down.
jest.mock('./ScheduleForm', () => ({
  __esModule: true,
  default: ({ initialSchedule, activeProgram }: { initialSchedule: unknown; activeProgram: unknown }) => (
    <div data-schedule={JSON.stringify(initialSchedule)} data-program={JSON.stringify(activeProgram)}>
      schedule-form
    </div>
  ),
}));

import { fetchUserSettings } from '@/lib/api';
import SchedulePage from './page';

const mockedFetch = fetchUserSettings as unknown as jest.Mock;

describe('SchedulePage — fetch fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the form with the fetched schedule on success', async () => {
    mockedFetch.mockResolvedValue({
      activeProgram: '5-3-1',
      workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
    });

    const element = (await SchedulePage()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).toContain('schedule-form');
    // Data-level assertion: the real fetched schedule reached the form.
    expect(html).toContain('&quot;type&quot;:&quot;fixed&quot;');
    // The active program reaches the form, which re-dates its current macrocycle (#1032).
    expect(html).toContain('data-program="&quot;5-3-1&quot;"');
  });

  it('falls back to a null schedule (no throw) when the API is unreachable', async () => {
    mockedFetch.mockRejectedValue(new Error('API down'));

    const element = (await SchedulePage()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).toContain('schedule-form');
    // The fallback passes workoutSchedule: null — distinct from any fetched value.
    expect(html).toContain('data-schedule="null"');
  });
});
