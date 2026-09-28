import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaExecutor } from './prisma-tx.util';
import { RLS_TX_CLIENT } from './rls-context';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  // Constructed manually in repository-factory.module.ts (and in tests), so ClsService is passed
  // explicitly rather than DI-injected. Optional so the standalone `new PrismaService()` test
  // harness — which never opens a request-scoped RLS transaction — still compiles.
  constructor(private readonly cls?: ClsService) {
    super();
  }

  async onModuleInit() {
    if (process.env.DATABASE_URL) {
      await this.$connect();
    }
  }

  async onModuleDestroy() {
    if (process.env.DATABASE_URL) {
      await this.$disconnect();
    }
  }

  /**
   * The Prisma client a request's queries must use to be RLS-scoped. When RlsInterceptor has opened
   * a per-request transaction (with `app.current_user_id` set) and stashed it in CLS, this returns
   * that transaction client so the GUC stays in scope; otherwise it returns the base client.
   *
   * PrismaRepositoryFactory routes its repositories through the equivalent lookup. Consumers that
   * build repositories OUTSIDE the factory (e.g. CustomProgramsController) or run raw queries
   * outside a repository (e.g. SwitchProgramController's custom-program ownership check) MUST use
   * `clientForRequest()` rather than the bare service — otherwise, under the non-superuser
   * `lifting_app` role, their queries run on the base connection with no GUC and fail closed (zero
   * rows). See issue #511. (UserSettingsController resolves IUserSettingsRepository through
   * RepositoryBundle like every other controller and no longer needs this directly — #1029.)
   */
  clientForRequest(): PrismaExecutor {
    if (this.cls?.isActive()) {
      const tx = this.cls.get(RLS_TX_CLIENT) as PrismaExecutor | undefined;
      return tx ?? this;
    }
    return this;
  }
}
