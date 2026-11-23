import { BadRequestException, CallHandler, ExecutionContext, InternalServerErrorException, Logger } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { defer, lastValueFrom, of } from 'rxjs';
import { RlsInterceptor } from './rls.interceptor';
import { PrismaService } from './prisma.service';
import { runAfterCommit } from './after-commit';

function makeCls(): ClsService {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn((key: string) => store.get(key)),
    set: jest.fn((key: string, value: unknown) => store.set(key, value)),
    run: jest.fn((fn: () => unknown) => fn()),
  } as unknown as ClsService;
}

function makeReflector(): Reflector {
  return { getAllAndOverride: jest.fn(() => undefined) } as unknown as Reflector;
}

function makeModuleRef(resolved: PrismaService | null): ModuleRef {
  return { get: jest.fn(() => resolved) } as unknown as ModuleRef;
}

// A real reflection target is required by Reflector.getAllAndOverride, but none of the tests below
// reach that call — the interceptor resolves (throw or no-op) before request/handler data is read.
const dummyHandler = function handler() {};
class DummyController {}

function makeContext(type: 'http' | 'rpc'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => {
      throw new Error('switchToHttp should not be called before the Prisma/DATABASE_URL guard resolves');
    },
    getHandler: () => dummyHandler,
    getClass: () => DummyController,
  } as unknown as ExecutionContext;
}

const passthroughHandler: CallHandler = { handle: () => of('handled') };

// Stubs the private isDatabaseUrlConfigured() seam directly rather than mutating process.env —
// jest.env.setup.js wraps process.env in a Proxy that discards writes to DATABASE_URL outside the
// Testcontainers sentinel, so this is the only way to unit-test the branch without Docker.
function stubDatabaseUrlConfigured(interceptor: RlsInterceptor, value: boolean): void {
  jest
    .spyOn(interceptor as unknown as { isDatabaseUrlConfigured(): boolean }, 'isDatabaseUrlConfigured')
    .mockReturnValue(value);
}

describe('RlsInterceptor', () => {
  describe('when PrismaService cannot be resolved and a real DB is expected (DATABASE_URL configured)', () => {
    it('throws InternalServerErrorException instead of silently no-oping (issue #649)', () => {
      const interceptor = new RlsInterceptor(makeCls(), makeReflector(), makeModuleRef(null));
      stubDatabaseUrlConfigured(interceptor, true);

      expect(() => interceptor.intercept(makeContext('http'), passthroughHandler)).toThrow(
        InternalServerErrorException,
      );
    });

    it('keeps the client-facing message generic and carries the diagnostic detail in `cause`', () => {
      const interceptor = new RlsInterceptor(makeCls(), makeReflector(), makeModuleRef(null));
      stubDatabaseUrlConfigured(interceptor, true);

      try {
        interceptor.intercept(makeContext('http'), passthroughHandler);
        throw new Error('expected intercept() to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InternalServerErrorException);
        const exception = err as InternalServerErrorException;
        expect(exception.message).not.toMatch(/DATABASE_URL/);
        expect((exception.cause as Error)?.message).toMatch(/DATABASE_URL/);
      }
    });
  });

  describe('when PrismaService cannot be resolved and no DB is configured (in-memory/SystemDb mode)', () => {
    it('no-ops and runs the request on next.handle() without throwing', async () => {
      const interceptor = new RlsInterceptor(makeCls(), makeReflector(), makeModuleRef(null));
      stubDatabaseUrlConfigured(interceptor, false);

      const result = await lastValueFrom(
        interceptor.intercept(makeContext('http'), passthroughHandler),
      );
      expect(result).toBe('handled');
    });
  });

  describe('non-HTTP context', () => {
    it('no-ops regardless of Prisma/DATABASE_URL state — RLS is HTTP-only today (issue #511)', async () => {
      const interceptor = new RlsInterceptor(makeCls(), makeReflector(), makeModuleRef(null));
      stubDatabaseUrlConfigured(interceptor, true);

      const result = await lastValueFrom(
        interceptor.intercept(makeContext('rpc'), passthroughHandler),
      );
      expect(result).toBe('handled');
    });
  });

  // ADR-047 decision 16 (#1444): work a request registers runs once its transaction has committed
  // and before its response, and never after a rollback or an error.
  describe('after-commit work', () => {
    /** A Prisma client whose transaction runs its callback, then commits or fails to. */
    function makePrisma(commit: 'commits' | 'fails'): PrismaService {
      const tx = { $executeRaw: jest.fn(async () => 1) };
      return {
        $transaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
          const result = await fn(tx);
          if (commit === 'fails') throw new Error('could not serialize access');
          return result;
        }),
      } as unknown as PrismaService;
    }

    function userContext(): ExecutionContext {
      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'user-1' }, routerPath: '/supplements/items' }) }),
        getHandler: () => dummyHandler,
        getClass: () => DummyController,
      } as unknown as ExecutionContext;
    }

    /** A handler that registers `work`, then answers or throws as a refused write would. */
    function registering(cls: ClsService, work: () => Promise<unknown>, answer: 'answers' | 'throws' = 'answers'): CallHandler {
      return {
        handle: () =>
          defer(async () => {
            runAfterCommit(cls, work);
            if (answer === 'throws') throw new BadRequestException('refused');
            return 'handled';
          }),
      };
    }

    it('runs the registered work once the transaction commits, before the response resolves', async () => {
      const cls = makeCls();
      const events: string[] = [];
      const work = jest.fn(async () => {
        events.push('work');
      });
      const interceptor = new RlsInterceptor(cls, makeReflector(), makeModuleRef(makePrisma('commits')));

      const result = await lastValueFrom(interceptor.intercept(userContext(), registering(cls, work)));
      events.push('response');

      expect(result).toBe('handled');
      expect(events).toEqual(['work', 'response']);
    });

    it('runs nothing when the commit fails', async () => {
      const cls = makeCls();
      const work = jest.fn(async () => undefined);
      const interceptor = new RlsInterceptor(cls, makeReflector(), makeModuleRef(makePrisma('fails')));

      await expect(lastValueFrom(interceptor.intercept(userContext(), registering(cls, work)))).rejects.toThrow(
        'could not serialize access',
      );
      expect(work).not.toHaveBeenCalled();
    });

    it('runs nothing when the handler throws, which answers with an error status', async () => {
      const cls = makeCls();
      const work = jest.fn(async () => undefined);
      const interceptor = new RlsInterceptor(cls, makeReflector(), makeModuleRef(makePrisma('commits')));

      await expect(lastValueFrom(interceptor.intercept(userContext(), registering(cls, work, 'throws')))).rejects.toThrow(
        BadRequestException,
      );
      expect(work).not.toHaveBeenCalled();
    });

    it('on the in-memory path, runs the work after a handler that answers and none after one that throws', async () => {
      const cls = makeCls();
      const interceptor = new RlsInterceptor(cls, makeReflector(), makeModuleRef(null));
      stubDatabaseUrlConfigured(interceptor, false);
      const ran = jest.fn(async () => undefined);
      const skipped = jest.fn(async () => undefined);

      await lastValueFrom(interceptor.intercept(makeContext('http'), registering(cls, ran)));
      await expect(lastValueFrom(interceptor.intercept(makeContext('http'), registering(cls, skipped, 'throws')))).rejects.toThrow(
        BadRequestException,
      );

      expect(ran).toHaveBeenCalledTimes(1);
      expect(skipped).not.toHaveBeenCalled();
    });

    it('still answers normally when the work fails, and logs it by outcome', async () => {
      const cls = makeCls();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const interceptor = new RlsInterceptor(cls, makeReflector(), makeModuleRef(makePrisma('commits')));

      const result = await lastValueFrom(
        interceptor.intercept(userContext(), registering(cls, async () => Promise.reject(new Error('queue down')))),
      );

      expect(result).toBe('handled');
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: 'rls.after_commit', outcome: 'failed', failed: 1 }), expect.any(String));
      warn.mockRestore();
    });
  });
});
