import { Controller, Get, Inject } from '@nestjs/common';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';

/**
 * The programs holding the user's sets, non-cycle workouts aside (#1454). A built-in template the
 * lifter isn't on and can't pick still holds an import's history, so the web lists it from here.
 */
@Controller('users/me/recorded-programs')
export class RecordedProgramsController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<string[]> {
    const { liftRecord } = await this.factory.forUser(user);
    return (await liftRecord.getRecordedPrograms()).filter((p) => p !== NON_CYCLE_PROGRAM).sort();
  }
}
