import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@prisma/client/runtime/library';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { SnapshotsController, TRAINING_DATA_TX_TIMEOUT_MS } from './snapshots.controller';
import { DATA_CHANGED, dataChanged } from './training-data.service';

const FAILURE_LOG = 'Training data action failed (#1309)';
const USER: AuthUser ={ id: 'snapshots-controller-spec', email: 'spec@example.com', provider: 'dev' };
const prismaError = (code: string, dbCode?: string) =>
  new PrismaClientKnownRequestError('Unique constraint failed on notes "row contents"', {
    code,
    clientVersion: '5.22.0',
    meta: dbCode === undefined ? { target: ['userId'] } : { code: dbCode, message: 'row contents' },
  });

/** The controller with a user context that fails with `failure`, and the error log it writes. */
function failingWith(failure: unknown) {
  const withUserContext = jest.fn().mockRejectedValue(failure);
  const controller = new SnapshotsController({} as IRepositoryFactory, { withUserContext } as unknown as RlsContextService);
  const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return { controller, withUserContext, logged };
}

describe('SnapshotsController failures (#1309)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs clear, restore and a download at the default level, READ COMMITTED, with the long timeout', async () => {
    const { controller, withUserContext } = failingWith(prismaError('P2034'));

    await expect(controller.clear(USER, { counts: {} as never })).rejects.toBeInstanceOf(ConflictException);
    await expect(controller.restore(USER, 'id')).rejects.toBeInstanceOf(ConflictException);
    await expect(controller.liftRecordParts(USER, 'id')).rejects.toBeInstanceOf(ConflictException);

    // A REPEATABLE READ snapshot would be fixed before the macrocycle lock's wait, and miss what
    // the writes it waited for added.
    expect(withUserContext.mock.calls.map((call) => call.slice(1))).toEqual([
      [TRAINING_DATA_TX_TIMEOUT_MS],
      [TRAINING_DATA_TX_TIMEOUT_MS],
      [TRAINING_DATA_TX_TIMEOUT_MS],
    ]);
  });

  it.each([
    ['P2034', undefined],
    ['P2003', undefined],
    ['P2010', '40P01'],
    ['P2010', '40001'],
  ])('turns %s %s, a write committed alongside, into a 409 that says nothing changed', async (code, dbCode) => {
    const { controller, logged } = failingWith(prismaError(code, dbCode));

    const err = await controller.restore(USER, 'id').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: DATA_CHANGED });
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ code, reason: DATA_CHANGED, ...(dbCode ? { dbCode } : {}) }),
      FAILURE_LOG,
    );
  });

  it('leaves another raw-query failure a 500, and logs its code but not its message', async () => {
    const failure = prismaError('P2010', '23505');
    const { controller, logged } = failingWith(failure);

    await expect(controller.restore(USER, 'id')).rejects.toBe(failure);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ code: 'P2010', dbCode: '23505' }), expect.any(String));
    expect(JSON.stringify(logged.mock.calls)).not.toContain('row contents');
  });

  it('logs a data-changed 409 the service raised as it logs the ones Postgres reports, and not a counts-changed one', async () => {
    const changed = dataChanged();
    const { controller, logged } = failingWith(changed);

    await expect(controller.clear(USER, { counts: {} as never })).rejects.toBe(changed);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ action: 'clear', reason: DATA_CHANGED }), FAILURE_LOG);

    logged.mockClear();
    const countsChanged = new ConflictException({ statusCode: 409, code: 'counts-changed' });
    await expect(failingWith(countsChanged).controller.clear(USER, { counts: {} as never })).rejects.toBe(countsChanged);
    expect(logged).not.toHaveBeenCalled();
  });

  it('turns a timeout into a 503', async () => {
    const { controller } = failingWith(prismaError('P2028'));

    await expect(controller.restore(USER, 'id')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('logs a failed save’s cause with its Prisma code, and never a Prisma message, which can quote rows', async () => {
    const wrapped = new ServiceUnavailableException('Your data couldn’t be backed up', { cause: prismaError('P2002') });
    const { controller, logged } = failingWith(wrapped);

    await expect(controller.clear(USER, { counts: {} as never })).rejects.toBe(wrapped);

    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'clear', error: 'PrismaClientKnownRequestError', code: 'P2002', target: ['userId'] }),
      'Training data action failed (#1309)',
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain('row contents');
  });

  it('leaves out the message of a Prisma error with no code', async () => {
    const { controller, logged } = failingWith(new PrismaClientValidationError('Argument notes: "row contents"', { clientVersion: '5.22.0' }));

    await expect(controller.restore(USER, 'id')).rejects.toBeInstanceOf(PrismaClientValidationError);

    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ error: 'PrismaClientValidationError' }), expect.any(String));
    expect(JSON.stringify(logged.mock.calls)).not.toContain('row contents');
  });
});
