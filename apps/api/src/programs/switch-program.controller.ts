import { Controller, ForbiddenException, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { SwitchProgramResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { CycleGenerationService } from './cycle-generation.service';
import { ParseProgramPipe } from './program.pipe';
import { ProgramNotFoundError } from '../ports/errors';

// Matches a standard UUID — used to detect custom program IDs vs catalog slugs.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('programs/:program')
export class SwitchProgramController {
  constructor(
    private readonly cycleGenerationService: CycleGenerationService,
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    @Inject(PrismaService) private readonly prisma: PrismaService | null,
  ) {}

  @Post('switch')
  @HttpCode(HttpStatus.OK)
  async switchProgram(
    @Param('program', ParseProgramPipe) program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<SwitchProgramResponse> {
    const repos = await this.factory.forUser(user);

    // Custom program IDs are UUIDs. Verify ownership before using the spec —
    // HybridLiftingProgramSpecRepository queries CustomProgramSpec by programId
    // without a userId filter, so we must gate here. Use ForbiddenException
    // rather than NotFoundException to avoid confirming UUID existence.
    // Custom programs are Prisma-only today (no in-memory twin — docs/domain-model.md D17,
    // first half), so no database means no custom program can exist; treat that the same as
    // an unowned UUID rather than special-casing it. clientForRequest() yields the per-request
    // RLS transaction client (GUC set) when active, so this ownership check is RLS-scoped under
    // lifting_app. See prisma.service.ts (#511).
    if (UUID_PATTERN.test(program)) {
      const db = this.prisma?.clientForRequest();
      const owned = db
        ? await db.customProgram.findFirst({ where: { id: program, userId: user.id } })
        : null;
      if (!owned) throw new ForbiddenException('Program not found');
    }

    // Ensure a CycleDashboard exists for this program; create if not.
    // Order is intentional: cycle init runs first so that if the settings write
    // fails the dashboard exists but is not yet referenced — a retry will skip
    // init and succeed at the settings write. The inverse (settings written,
    // init failed) would leave the user's active program pointing at a cycle
    // that doesn't exist yet, which is a harder state to recover from.
    let cycleNum = 1;
    try {
      const existing = await repos.cycleDashboard.getCycleDashboard(program);
      cycleNum = existing.cycleNum;
    } catch (e) {
      if (e instanceof ProgramNotFoundError) {
        const { dashboard } = await this.cycleGenerationService.initializeFirstCycle(repos, program);
        cycleNum = dashboard.cycleNum;
      } else {
        throw e;
      }
    }

    await repos.userSettings.upsertSettings({ activeProgram: program });

    return { activeProgram: program, cycleNum };
  }
}
