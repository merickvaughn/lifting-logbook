import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Put } from '@nestjs/common';
import { ModificationMaxResponse, TrainingMaxResponse } from '@lifting-logbook/types';
import type { TrainingMax } from '@lifting-logbook/core';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { LiftModificationNotFoundError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { toModificationMaxResponse, toTrainingMaxResponse } from './mappers';
import { PutModificationMaxDto } from './put-modification-max.dto';
import { UpdateTrainingMaxesDto } from './update-training-maxes.dto';

@Controller('programs/:program')
export class TrainingMaxesController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Get('training-maxes')
  async getTrainingMaxes(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TrainingMaxResponse[]> {
    const { trainingMax } = await this.factory.forUser(user);
    const maxes = await trainingMax.getTrainingMaxes(program);
    return maxes.map(toTrainingMaxResponse);
  }

  @Patch('training-maxes')
  async updateTrainingMaxes(
    @Param('program') program: string,
    @Body() body: UpdateTrainingMaxesDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TrainingMaxResponse[]> {
    const { trainingMax } = await this.factory.forUser(user);
    const existing = await trainingMax.getTrainingMaxes(program);
    const incomingMap = new Map(
      body.maxes.map((m) => [m.lift, m.weight]),
    );
    const today = new Date();
    // Only a changed weight is an update. The settings form sends every row, and stamping
    // unchanged ones would make an old max look newer than an imported one (#1118).
    const merged: TrainingMax[] = existing.map((m) => {
      const weight = incomingMap.get(m.lift);
      return weight !== undefined && weight !== m.weight
        ? { lift: m.lift, weight, dateUpdated: today }
        : m;
    });
    for (const incoming of body.maxes) {
      if (!merged.some((m) => m.lift === incoming.lift)) {
        merged.push({ lift: incoming.lift, weight: incoming.weight, dateUpdated: today });
      }
    }
    await trainingMax.saveTrainingMaxes(program, merged);
    return merged.map(toTrainingMaxResponse);
  }

  /**
   * The program's own maxes of modifications (#1153), archived modifications' included. Only those
   * whose mode is `own` now: a mode change keeps the max stored, so changing back restores it, but
   * until then nothing should plan from it. The logger plans from every max this returns.
   */
  @Get('modification-maxes')
  async getModificationMaxes(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ModificationMaxResponse[]> {
    const { liftModification } = await this.factory.forUser(user);
    const own = new Set((await liftModification.list()).filter((m) => m.maxMode === 'own').map((m) => m.id));
    return (await liftModification.getMaxes(program))
      .filter((m) => own.has(m.modificationId))
      .map(toModificationMaxResponse);
  }

  /**
   * Sets a modification's own max in this program, the way the training-max form sets a lift's.
   * A 404 for a modification that isn't the user's, or is archived; a 400 unless its `maxMode` is
   * `own`, since no other kind plans from or moves one.
   */
  @Put('modification-maxes/:modificationId')
  async putModificationMax(
    @Param('program') program: string,
    @Param('modificationId') modificationId: string,
    @Body() body: PutModificationMaxDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ModificationMaxResponse> {
    const { liftModification } = await this.factory.forUser(user);
    const modification = (await liftModification.list()).find((m) => m.id === modificationId && !m.archivedAt);
    if (!modification) throw new LiftModificationNotFoundError(modificationId);
    if (modification.maxMode !== 'own') {
      throw new BadRequestException(`'${modification.name}' doesn't keep its own max`);
    }
    // Only a changed weight is an update, as for a lift's max (#1118): the editor saves every
    // own max at once, and stamping unchanged ones would make an old max look newer.
    const stored = (await liftModification.getMaxes(program)).find((m) => m.modificationId === modificationId);
    if (stored?.weight === body.weight) return toModificationMaxResponse(stored);
    const max = { modificationId, weight: body.weight, dateUpdated: new Date() };
    await liftModification.saveMaxes(program, [max]);
    return toModificationMaxResponse(max);
  }
}
