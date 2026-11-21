import { render, screen } from '@testing-library/react';
import { STACK } from '@/lib/__tests__/supplementsTestStack';

jest.mock('@/lib/api', () => ({ fetchSupplements: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/client-api', () => ({ updateSupplementItem: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

import { fetchSupplements } from '@/lib/api';
import { logClientError } from '@/lib/log-client-error';
import SupplementsPage from './page';

beforeEach(() => jest.clearAllMocks());

describe('SupplementsPage', () => {
  it('renders the stack when the fetch succeeds', async () => {
    (fetchSupplements as jest.Mock).mockResolvedValue(STACK);
    render(await SupplementsPage());
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
    render(await SupplementsPage());
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load your supplements');
    expect(screen.queryByRole('button', { name: /Nutricost Pre-X/ })).toBeNull();
    expect(serverLog).toHaveBeenCalledWith('[SupplementsPage] supplements fetch failed', err);
    expect(logClientError).toHaveBeenCalledWith('supplements.load', expect.objectContaining({ message: 'API 500 Internal Server Error for /supplements' }));
    serverLog.mockRestore();
  });
});
