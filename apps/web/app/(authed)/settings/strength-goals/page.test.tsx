import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchCustomLifts: jest.fn(),
  fetchLatestBodyWeight: jest.fn().mockResolvedValue(null),
  fetchStrengthGoals: jest.fn().mockResolvedValue([]),
  fetchTrainingMaxes: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/active-program', () => ({ getActiveProgram: jest.fn().mockResolvedValue('5-3-1') }));
jest.mock('@/lib/preferences', () => ({ getPreferredUnit: jest.fn().mockResolvedValue('lbs') }));

// Stub the client form so the test isolates the page's custom-lift fetch. It echoes the
// custom lifts it was given so we can assert what the page passed down.
jest.mock('./StrengthGoalsForm', () => ({
  __esModule: true,
  default: ({ customLifts }: { customLifts: unknown }) => (
    <div data-custom-lifts={JSON.stringify(customLifts)}>strength-goals-form</div>
  ),
}));

import { fetchCustomLifts } from '@/lib/api';
import StrengthGoalsPage from './page';

const mockedFetchCustomLifts = fetchCustomLifts as unknown as jest.Mock;

describe('StrengthGoalsPage — custom lift names (#1179)', () => {
  beforeEach(() => mockedFetchCustomLifts.mockReset());

  it('passes the fetched custom lifts to the form', async () => {
    mockedFetchCustomLifts.mockResolvedValue([{ id: 'custom-1', name: 'Squat (custom)' }]);
    const html = renderToStaticMarkup((await StrengthGoalsPage()) as ReactElement);
    // Data-level assertion: the real fetched lift reached the form.
    expect(html).toContain('Squat (custom)');
  });

  it('still renders the form, with no custom lifts, when they can\'t be read', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedFetchCustomLifts.mockRejectedValue(new Error('API down'));
    const html = renderToStaticMarkup((await StrengthGoalsPage()) as ReactElement);
    expect(html).toContain('strength-goals-form');
    expect(html).toContain('data-custom-lifts="[]"');
    expect(error).toHaveBeenCalledWith(
      '[StrengthGoalsPage] custom lifts fetch failed, showing custom lifts by id',
      expect.any(Error),
    );
    error.mockRestore();
  });
});
