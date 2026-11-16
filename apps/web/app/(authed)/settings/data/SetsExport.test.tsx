import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SetsExport from './SetsExport';
import { downloadLiftRecordExport, fetchLiftRecordExportParts, fetchMacrocycles } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

jest.mock('@/lib/client-api', () => ({
  downloadLiftRecordExport: jest.fn(),
  fetchLiftRecordExportParts: jest.fn(),
  fetchMacrocycles: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const listParts = fetchLiftRecordExportParts as jest.Mock;
const downloadPart = downloadLiftRecordExport as jest.Mock;
const macrocycles = fetchMacrocycles as jest.Mock;

const programs = [{ id: '5-3-1', name: '5/3/1', isTemplate: true }];
const threeParts = {
  rows: 12_400,
  split: '0123456789abcdef',
  parts: [
    { part: 1, rows: 4_900, from: '2016-01-04', to: '2019-06-28' },
    { part: 2, rows: 4_800, from: '2019-07-01', to: '2022-12-30' },
    { part: 3, rows: 2_700, from: '2023-01-02', to: '2024-05-31' },
  ],
};

describe('Settings → Data → Download sets', () => {
  const saved: string[] = [];
  let click: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    saved.length = 0;
    URL.createObjectURL = jest.fn(() => 'blob:sets');
    URL.revokeObjectURL = jest.fn();
    click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    macrocycles.mockResolvedValue([
      { id: 'mc-1', macrocycleNum: 1, startDate: '2024-01-01', endDate: '2024-03-01', status: 'completed', origin: 'imported', current: false, unmatched: false },
    ]);
  });

  afterEach(() => click.mockRestore());

  it('lists one download per part, oldest first, with the note to upload them in that order', async () => {
    const user = userEvent.setup();
    listParts.mockResolvedValue(threeParts);
    render(<SetsExport programs={programs} />);

    await user.click(screen.getByRole('button', { name: 'Find sets' }));

    const buttons = await screen.findAllByRole('button', { name: /^Download part/ });
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Download part 1 of 3',
      'Download part 2 of 3',
      'Download part 3 of 3',
    ]);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('2016-01-04 to 2019-06-28, 4,900 sets');
    expect(screen.getByText(/in this order, oldest first/)).toBeInTheDocument();
    expect(screen.getByText(/12,400 sets in 3 parts/)).toBeInTheDocument();
    expect(listParts).toHaveBeenCalledWith({});
  });

  it('sends the chosen filters, and each part’s download names the part and the split', async () => {
    const user = userEvent.setup();
    listParts.mockResolvedValue(threeParts);
    downloadPart.mockResolvedValue(new Blob(['csv']));
    render(<SetsExport programs={programs} />);

    await user.selectOptions(screen.getByLabelText('Program'), '5-3-1');
    expect(macrocycles).toHaveBeenCalledWith('5-3-1');
    await user.selectOptions(await screen.findByLabelText('Macrocycle'), 'mc-1');
    await user.type(screen.getByLabelText('From'), '2024-01-01');
    await user.click(screen.getByRole('button', { name: 'Find sets' }));
    expect(listParts).toHaveBeenCalledWith({ program: '5-3-1', macrocycle: 'mc-1', from: '2024-01-01' });

    await user.click(await screen.findByRole('button', { name: 'Download part 2 of 3' }));

    expect(downloadPart).toHaveBeenCalledWith({
      program: '5-3-1',
      macrocycle: 'mc-1',
      from: '2024-01-01',
      part: 2,
      split: '0123456789abcdef',
    });
    expect(saved).toEqual([expect.stringMatching(/^lift-records-\d{4}-\d{2}-\d{2}-part-2-of-3\.csv$/)]);
  });

  it('offers a single download, with no upload-order note, for one part', async () => {
    const user = userEvent.setup();
    listParts.mockResolvedValue({ ...threeParts, rows: 10, parts: [{ part: 1, rows: 10, from: '2024-01-01', to: '2024-01-05' }] });
    render(<SetsExport programs={programs} />);

    await user.click(screen.getByRole('button', { name: 'Find sets' }));

    expect(await screen.findByRole('button', { name: 'Download sets' })).toBeInTheDocument();
    expect(screen.queryByText(/oldest first/)).not.toBeInTheDocument();
  });

  it('drops a listing when a filter changes, since it was made for the old one', async () => {
    const user = userEvent.setup();
    listParts.mockResolvedValue(threeParts);
    render(<SetsExport programs={programs} />);
    await user.click(screen.getByRole('button', { name: 'Find sets' }));
    await screen.findAllByRole('button', { name: /^Download part/ });

    await user.selectOptions(screen.getByLabelText('Program'), 'non-cycle');

    expect(screen.queryByRole('button', { name: /^Download part/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Macrocycle')).not.toBeInTheDocument();
  });

  it('shows and reports a part whose split changed, and keeps the other parts', async () => {
    const user = userEvent.setup();
    const changed = new Error('List the parts again and download each one.');
    listParts.mockResolvedValue(threeParts);
    downloadPart.mockRejectedValue(changed);
    render(<SetsExport programs={programs} />);
    await user.click(screen.getByRole('button', { name: 'Find sets' }));

    await user.click(await screen.findByRole('button', { name: 'Download part 1 of 3' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('List the parts again');
    expect(logClientError).toHaveBeenCalledTimes(1);
    expect(logClientError).toHaveBeenCalledWith('downloadLiftRecordExport', changed, { part: '1' });
    expect(saved).toEqual([]);
    expect(screen.getByRole('button', { name: 'Download part 3 of 3' })).toBeEnabled();
  });

  it('shows and reports a listing that failed', async () => {
    const user = userEvent.setup();
    const failure = new Error('API down');
    listParts.mockRejectedValue(failure);
    render(<SetsExport programs={programs} />);

    await user.click(screen.getByRole('button', { name: 'Find sets' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('API down');
    expect(logClientError).toHaveBeenCalledWith('fetchLiftRecordExportParts', failure);
  });
});
