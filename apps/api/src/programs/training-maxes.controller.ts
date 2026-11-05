import { Body, Controller, Get, Inject, Param, Patch } from '@nestjs/common';
import { TrainingMaxResponse } from '@lifting-logbook/types';
import type { TrainingMax } from '@lifting-logbook/core';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { toTrainingMaxResponse } from './mappers';
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
}
