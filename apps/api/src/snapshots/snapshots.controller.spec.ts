import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError, PrismaClientValidationError } from '@prisma/client/runtime/library';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { SnapshotsController, TRAINING_DATA_TX_TIMEOUT_MS } from './snapshots.controller';

const USER: AuthUser = { id: 'snapshots-controller-spec', email: 'spec@example.com', provider: 'dev' };
const prismaError = (code: string) =>
  new PrismaClientKnownRequestError('Unique constraint failed on notes "row contents"', {
    code,
    clientVersion: '5.22.0',
    meta: { target: ['userId'] },
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

  it('runs clear and restore at REPEATABLE READ, and a download at the default level', async () => {
    const { controller, withUserContext } = failingWith(prismaError('P2034'));

    await expect(controller.clear(USER, { counts: {} as never })).rejects.toBeInstanceOf(ConflictException);
    await expect(controller.restore(USER, 'id')).rejects.toBeInstanceOf(ConflictException);
    await expect(controller.liftRecordParts(USER, 'id')).rejects.toBeInstanceOf(ConflictException);

    expect(withUserContext.mock.calls.map((call) => call.slice(1))).toEqual([
      [TRAINING_DATA_TX_TIMEOUT_MS, Prisma.TransactionIsolationLevel.RepeatableRead],
      [TRAINING_DATA_TX_TIMEOUT_MS, Prisma.TransactionIsolationLevel.RepeatableRead],
      [TRAINING_DATA_TX_TIMEOUT_MS, undefined],
    ]);
  });

  it.each(['P2034', 'P2003'])('turns %s, a write committed alongside, into a 409 that says nothing changed', async (code) => {
    const { controller } = failingWith(prismaError(code));

    const err = await controller.restore(USER, 'id').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: 'data-changed' });
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
