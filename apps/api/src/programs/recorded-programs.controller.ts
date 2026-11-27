import { Controller, Get, Inject } from '@nestjs/common';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';

/**
 * The programs holding the user's sets or macrocycles, non-cycle workouts aside (#1454, #1304). A
 * built-in template the lifter isn't on, or can't pick, still holds an import's history, so the
 * web lists it from here.
 */
@Controller('users/me/recorded-programs')
export class RecordedProgramsController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<string[]> {
    const { liftRecord, macrocycle } = await this.factory.forUser(user);
    const [recorded, macrocycles] = await Promise.all([liftRecord.getRecordedPrograms(), macrocycle.listAll()]);
    const programs = new Set([...recorded, ...macrocycles.map((m) => m.program)]);
    programs.delete(NON_CYCLE_PROGRAM);
    return [...programs].sort();
  }
}
