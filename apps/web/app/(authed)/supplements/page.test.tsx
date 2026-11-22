import { render, screen } from '@testing-library/react';
import { STACK } from '@/lib/__tests__/supplementsTestStack';

jest.mock('@/lib/api', () => ({ fetchSupplements: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/client-api', () => ({
  updateSupplementItem: jest.fn(),
  fetchSupplementChanges: jest.fn().mockResolvedValue([]),
  fetchSupplementsAsOf: jest.fn().mockResolvedValue({ items: [], dayTypes: [], firstChangeDate: null, anomalies: [] }),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

import { fetchSupplements } from '@/lib/api';
import { fetchSupplementsAsOf } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import SupplementsPage from './page';

const page = (search: { history?: string | string[] } = {}) => SupplementsPage({ searchParams: Promise.resolve(search) });

beforeEach(() => jest.clearAllMocks());

describe('SupplementsPage', () => {
  it('renders the stack when the fetch succeeds', async () => {
    (fetchSupplements as jest.Mock).mockResolvedValue(STACK);
    render(await page());
    expect(screen.getByRole('heading', { name: 'What I’m on' })).toBeInTheDocument();
    // Data-level: a fallback could not produce the lifter's own items.
    expect(screen.getByRole('button', { name: /Nutricost Pre-X/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(logClientError).not.toHaveBeenCalled();
  });

  it('renders an error state, and reports it on the server and through logClientError, when the fetch fails', async () => {
    const serverLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('API 500 Internal Server Error for /supplements');
    (fetchSupplements as jest.Mock).mockRejectedValue(err);
    render(await page());
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load your supplements');
    expect(screen.queryByRole('button', { name: /Nutricost Pre-X/ })).toBeNull();
    expect(serverLog).toHaveBeenCalledWith('[SupplementsPage] supplements fetch failed', err);
    expect(logClientError).toHaveBeenCalledWith('supplements.load', expect.objectContaining({ message: 'API 500 Internal Server Error for /supplements' }));
    serverLog.mockRestore();
  });

  it('opens History at the date a Lift History link gives', async () => {
    (fetchSupplements as jest.Mock).mockResolvedValue(STACK);
    render(await page({ history: '2026-06-01' }));
    expect(screen.getByRole('dialog', { name: 'Supplement history' })).toBeInTheDocument();
    expect(screen.getByLabelText('Date')).toHaveValue('2026-06-01');
    expect(fetchSupplementsAsOf).toHaveBeenCalledWith('2026-06-01');
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument();
  });

  it.each([['06/01/2026'], ['2026-02-30'], [['2026-06-01', '2026-06-02']]])('opens no dialog for a history value of %p', async (history) => {
    (fetchSupplements as jest.Mock).mockResolvedValue(STACK);
    render(await page({ history }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSupplementsAsOf).not.toHaveBeenCalled();
  });
});
