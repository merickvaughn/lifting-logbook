import { Prisma } from '@prisma/client';
import { BatchMacrocycles } from '../../ports/IImportBatchRepository';
import { batchMacrocyclesJson, parseBatchMacrocycles } from './import-batch-json';

describe('parseBatchMacrocycles (#1255)', () => {
  it('reads the column as save writes it', () => {
    const macrocycles: BatchMacrocycles = {
      created: ['m-1', 'm-2'],
      extended: ['m-3'],
      chosen: [
        { id: 'm-1', chose: 'completed', before: { statusChosen: false } },
        { id: 'm-3', chose: 'abandoned', before: { status: 'in-progress', statusChosen: false } },
      ],
    };
    // Read back as Postgres returns it: through JSON.
    const column: Prisma.JsonValue = JSON.parse(JSON.stringify(batchMacrocyclesJson(macrocycles)));
    expect(parseBatchMacrocycles(column)).toEqual(macrocycles);
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
        extended: ['m-2', { id: 'm-4' }],
        chosen: [
          'm-2',
          { id: 'm-2', chose: 'retired', before: { statusChosen: false } },
          { id: 'm-2', chose: 'overran', before: { status: 'in-progress', statusChosen: 'yes' } },
          { id: 'm-2', chose: 'overran', before: null },
          { id: 'm-2', chose: 'overran', before: { status: 'retired', statusChosen: true } },
        ],
      }),
    ).toEqual({ created: ['m-1'], extended: ['m-2'], chosen: [{ id: 'm-2', chose: 'overran', before: { statusChosen: true } }] });
    expect(parseBatchMacrocycles({ created: 'm-1' })).toEqual({ created: [], extended: [], chosen: [] });
  });
});
