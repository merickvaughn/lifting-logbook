import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { RLS_SKIP_TX } from '../adapters/prisma/rls-context';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { DATA_EXPORT_TX_TIMEOUT_MS, DataExportController } from './data-export.controller';

const USER = { id: 'user-1' } as unknown as AuthUser;

describe('DataExportController', () => {
  let error: jest.SpyInstance;

  const controller = (withUserContext: jest.Mock) =>
    new DataExportController(
      {} as IRepositoryFactory,
      { withUserContext } as unknown as RlsContextService,
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('opts out of the per-request transaction, and gives its reads their own budget', async () => {
    expect(Reflect.getMetadata(RLS_SKIP_TX, DataExportController.prototype.download)).toBe(true);

    const withUserContext = jest.fn().mockRejectedValue(new Error('stop here'));
    await expect(controller(withUserContext).download(USER)).rejects.toThrow('stop here');

    expect(withUserContext).toHaveBeenCalledWith(expect.any(Function), DATA_EXPORT_TX_TIMEOUT_MS);
    expect(DATA_EXPORT_TX_TIMEOUT_MS).toBe(30_000);
  });

  it('says a timed-out read is about the download, and logs the failure', async () => {
    const timedOut = new PrismaClientKnownRequestError('Transaction timed out', {
      code: 'P2028',
      clientVersion: 'test',
    });

    const result = controller(jest.fn().mockRejectedValue(timedOut)).download(USER);

    await expect(result).rejects.toThrow(ServiceUnavailableException);
    await expect(result).rejects.toThrow(/nothing was downloaded/);
    expect(error).toHaveBeenCalledWith(
      { durationMs: expect.any(Number), code: 'P2028' },
      'Data export failed (#947)',
    );
  });

  it('passes any other failure on unchanged, and logs no contents', async () => {
    const failure = new Error('private row contents');

    await expect(controller(jest.fn().mockRejectedValue(failure)).download(USER)).rejects.toBe(failure);

    expect(JSON.stringify(error.mock.calls)).not.toContain('private row contents');
  });
});
