import { Controller, Get, Inject, Query } from '@nestjs/common';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';

/**
 * The programs holding the user's sets, non-cycle workouts aside (#1454). A built-in template the
 * lifter isn't on, or can't pick, still holds an import's history, so the web lists it from here.
 * With `?macrocycles=true` it adds the programs holding their macrocycles, which History shows
 * (#1304). The sets filter leaves them out: switching to a program writes a macrocycle, so a
 * template tried with nothing logged would offer no sets to download (#1355).
 */
@Controller('users/me/recorded-programs')
export class RecordedProgramsController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('macrocycles') withMacrocycles?: string): Promise<string[]> {
    const { liftRecord, macrocycle } = await this.factory.forUser(user);
    const [recorded, macrocycles] = await Promise.all([
      liftRecord.getRecordedPrograms(),
      withMacrocycles === 'true' ? macrocycle.listAll() : [],
    ]);
    const programs = new Set([...recorded, ...macrocycles.map((m) => m.program)]);
    programs.delete(NON_CYCLE_PROGRAM);
    return [...programs].sort();
  }
}
