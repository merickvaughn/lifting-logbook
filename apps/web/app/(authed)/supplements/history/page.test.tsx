import { render, screen } from '@testing-library/react';
import { dose, item } from '@/lib/__tests__/supplementsTestStack';

jest.mock('@/lib/api', () => ({ fetchSupplementsAsOf: jest.fn(), fetchSupplementChanges: jest.fn(), fetchSupplements: jest.fn() }));
jest.mock('@/lib/userToday', () => ({ getUserToday: jest.fn().mockResolvedValue('2026-11-21') }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/client-api', () => ({ restoreSupplementItem: jest.fn(), fetchSupplementChanges: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));

import { fetchSupplementChanges, fetchSupplements, fetchSupplementsAsOf } from '@/lib/api';
import { logClientError } from '@/lib/log-client-error';
import SupplementHistoryPage from './page';

const glycine = item('glycine', 'Glycine', { doses: [dose('am', '3 g')] });
const stack = { items: [], dayTypes: [], caffeineCutoff: '15:00' };

beforeEach(() => {
  jest.clearAllMocks();
  (fetchSupplementsAsOf as jest.Mock).mockResolvedValue({ items: [glycine], dayTypes: [], firstChangeDate: '2026-11-18', anomalies: [] });
  (fetchSupplementChanges as jest.Mock).mockResolvedValue([{ seq: 1, date: '2026-11-18', type: 'added', item: glycine }]);
  (fetchSupplements as jest.Mock).mockResolvedValue(stack);
});

const params = (date?: string | string[]) => Promise.resolve({ date });

describe('SupplementHistoryPage', () => {
  it('replays the stack as of the date in the link', async () => {
    render(await SupplementHistoryPage({ searchParams: params('2026-11-19') }));
    expect(fetchSupplementsAsOf).toHaveBeenCalledWith('2026-11-19');
    expect(screen.getByLabelText('What was I on?')).toHaveValue('2026-11-19');
    // Data-level: a fallback could not produce the lifter's own item or change.
    expect(screen.getByText('Morning · 3 g')).toBeInTheDocument();
    expect(screen.getByText('Added Glycine')).toBeInTheDocument();
  });

  it('defaults to today for a missing, malformed or repeated date', async () => {
    for (const bad of [undefined, '2026-02-30', 'soon', ['2026-11-01', '2026-11-02']]) {
      (fetchSupplementsAsOf as jest.Mock).mockClear();
      render(await SupplementHistoryPage({ searchParams: params(bad) }));
      expect(fetchSupplementsAsOf).toHaveBeenCalledWith('2026-11-21');
    }
  });

  it('renders an error state, and reports it on the server and through logClientError, when a fetch fails', async () => {
    const serverLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('API 500 Internal Server Error for /supplements/as-of/2026-11-19');
    (fetchSupplementsAsOf as jest.Mock).mockRejectedValue(err);
    render(await SupplementHistoryPage({ searchParams: params('2026-11-19') }));
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load your supplements');
    expect(screen.queryByText('Added Glycine')).toBeNull();
    expect(serverLog).toHaveBeenCalledWith('[SupplementHistoryPage] history fetch failed', err);
    expect(logClientError).toHaveBeenCalledWith('supplements.load', expect.objectContaining({ message: err.message }));
    serverLog.mockRestore();
  });
});
