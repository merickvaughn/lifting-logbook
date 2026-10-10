import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { InMemoryRepositoryFactory } from './in-memory-repository-factory';
import { SystemDbRepositoryFactory } from './system-db-repository-factory';
import { PrismaRepositoryFactory } from '../prisma/prisma-repository-factory';
import { PrismaService } from '../prisma/prisma.service';
import { RlsInterceptor } from '../prisma/rls.interceptor';
import { RlsContextService } from '../prisma/rls-context.service';
import { REPOSITORY_FACTORY } from '../../ports/tokens';

@Global()
@Module({
  providers: [
    // Only instantiate PrismaService (and load the Prisma engine binary) when DATABASE_URL is set.
    {
      provide: PrismaService,
      // ClsService is passed so PrismaService.clientForRequest() can route repositories built
      // outside the factory through the per-request RLS transaction. See prisma.service.ts (#511).
      useFactory: (cls: ClsService) =>
        process.env.DATABASE_URL ? new PrismaService(cls) : null,
      inject: [ClsService],
    },
    {
      provide: REPOSITORY_FACTORY,
      useFactory: (prisma: PrismaService | null, cls: ClsService) => {
        if (process.env.DATABASE_URL && prisma) {
          return new PrismaRepositoryFactory(prisma, cls);
        }
        if (process.env.SYSTEM_DATABASE_URL) {
          return new SystemDbRepositoryFactory();
        }
        return new InMemoryRepositoryFactory();
      },
      inject: [{ token: PrismaService, optional: true }, ClsService],
    },
    // Establishes the per-request Postgres RLS context (sets app.current_user_id inside a
    // transaction and routes repositories through it). No-ops on the in-memory/SystemDb paths
    // and on unauthenticated routes. See rls.interceptor.ts.
    { provide: APP_INTERCEPTOR, useClass: RlsInterceptor },
    // Opens a short-lived per-operation RLS transaction for @SkipRlsTransaction() handlers
    // (macrocycle-plan). PrismaService is optional — null on the in-memory/SystemDb paths, where
    // withUserContext runs its callback directly. See rls-context.service.ts (#518).
    {
      provide: RlsContextService,
      useFactory: (cls: ClsService, prisma: PrismaService | null) =>
        new RlsContextService(cls, prisma),
      inject: [ClsService, { token: PrismaService, optional: true }],
    },
  ],
  exports: [REPOSITORY_FACTORY, PrismaService, RlsContextService],
})
export class RepositoryFactoryModule {}
