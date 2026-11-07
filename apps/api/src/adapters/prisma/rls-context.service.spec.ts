import { ClsService } from 'nestjs-cls';
import { RlsContextService } from './rls-context.service';
import { PrismaService } from './prisma.service';
import { RLS_TX_CLIENT, RLS_USER_ID_KEY } from './rls-context';

// Minimal CLS stand-in backed by a Map — enough for get/set of the two keys this service uses.
function makeCls(initial: Record<string, unknown> = {}): ClsService {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: jest.fn((key: string) => store.get(key)),
    set: jest.fn((key: string, value: unknown) => store.set(key, value)),
  } as unknown as ClsService;
}

describe('RlsContextService', () => {
  describe('with a Prisma client', () => {
    it('opens a transaction, sets the GUC, binds the tx client during fn, and clears it after', async () => {
      const tx = { $executeRaw: jest.fn().mockResolvedValue(undefined) };
      const prisma = {
        $transaction: jest.fn(
          async (
            cb: (client: typeof tx) => Promise<unknown>,
            _opts?: { timeout: number },
          ) => cb(tx),
        ),
      } as unknown as PrismaService;
      const cls = makeCls({ [RLS_USER_ID_KEY]: 'user-42' });
      const service = new RlsContextService(cls, prisma);

      let txClientDuringFn: unknown = 'unset';
      const result = await service.withUserContext(async () => {
        txClientDuringFn = cls.get(RLS_TX_CLIENT);
        return 'ok';
      });

      expect(result).toBe('ok');
      // set_config was issued (tagged-template first arg) with the CLS userId as the bind value.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining('set_config')]),
        'user-42',
      );
      // tx client is bound during fn...
      expect(txClientDuringFn).toBe(tx);
      // ...and torn down afterwards so a later op cannot reuse the closed tx client.
      expect(cls.get(RLS_TX_CLIENT)).toBeUndefined();
      // short-lived transaction carries an explicit timeout
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 5_000,
      });
    });

    it('uses a longer timeout when the caller passes one', async () => {
      const tx = { $executeRaw: jest.fn().mockResolvedValue(undefined) };
      const prisma = {
        $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
      } as unknown as PrismaService;
      const service = new RlsContextService(makeCls({ [RLS_USER_ID_KEY]: 'user-42' }), prisma);

      await service.withUserContext(async () => 'ok', 30_000);

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000 });
    });

    it('clears the tx-client binding even when fn throws', async () => {
      const tx = { $executeRaw: jest.fn().mockResolvedValue(undefined) };
      const prisma = {
        $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
      } as unknown as PrismaService;
      const cls = makeCls({ [RLS_USER_ID_KEY]: 'user-42' });
      const service = new RlsContextService(cls, prisma);

      await expect(
        service.withUserContext(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(cls.get(RLS_TX_CLIENT)).toBeUndefined();
    });

    it('throws without opening a transaction when no userId is in CLS', async () => {
      const prisma = { $transaction: jest.fn() } as unknown as PrismaService;
      const cls = makeCls();
      const service = new RlsContextService(cls, prisma);

      await expect(service.withUserContext(async () => 'x')).rejects.toThrow(
        /outside an RLS context/,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('without a Prisma client (in-memory mode)', () => {
    it('runs the callback directly with no transaction', async () => {
      const cls = makeCls();
      const service = new RlsContextService(cls, null);

      const result = await service.withUserContext(async () => 'in-memory');

      expect(result).toBe('in-memory');
      // No userId required and no CLS writes in passthrough mode.
      expect(cls.set).not.toHaveBeenCalled();
    });
  });
});
