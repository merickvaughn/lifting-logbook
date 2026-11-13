import { parseBatchMacrocycles } from './import-batch-json';

describe('parseBatchMacrocycles (#1255)', () => {
  it('reads the column as save writes it', () => {
    const column = {
      created: ['m-1', 'm-2'],
      extended: [{ id: 'm-3', before: { status: 'in-progress', statusChosen: false, unmatched: false }, wrote: { status: 'abandoned', statusChosen: true, unmatched: true } }],
    };
    expect(parseBatchMacrocycles(column)).toEqual(column);
  });

  it('reads a batch without the column as null', () => {
    expect(parseBatchMacrocycles(null)).toBeNull();
  });

  it('reads an unreadable column as null, and drops only the unreadable parts of a readable one', () => {
    expect(parseBatchMacrocycles(['m-1'])).toBeNull();
    expect(parseBatchMacrocycles('m-1')).toBeNull();
    expect(
      parseBatchMacrocycles({
        created: ['m-1', 7, null],
        extended: [
          'm-2',
          { before: {}, wrote: {} },
          { id: 'm-3', before: { status: 'retired', statusChosen: 'yes', unmatched: false }, wrote: null },
        ],
      }),
    ).toEqual({ created: ['m-1'], extended: [{ id: 'm-3', before: { unmatched: false }, wrote: {} }] });
    expect(parseBatchMacrocycles({ created: 'm-1' })).toEqual({ created: [], extended: [] });
  });
});
