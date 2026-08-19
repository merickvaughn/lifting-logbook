import { Body, Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { BodyWeightEntry, BodyWeightResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { RecordBodyWeightDto } from './record-body-weight.dto';

@Controller('programs/:program')
export class BodyWeightController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Post('body-weight')
  @HttpCode(HttpStatus.CREATED)
  async recordBodyWeight(
    @Param('program') program: string,
    @Body() body: RecordBodyWeightDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    const { bodyWeight } = await this.factory.forUser(user);
    const entry: BodyWeightEntry = {
      date: new Date(body.date),
      weight: body.weight,
      unit: body.unit,
    };
    await bodyWeight.recordBodyWeight(program, entry);
  }

  @Get('body-weight/latest')
  async getLatestBodyWeight(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<BodyWeightResponse> {
    const { bodyWeight } = await this.factory.forUser(user);
    const entry = await bodyWeight.getLatestBodyWeight(program);
    if (!entry) {
      throw new NotFoundException(`No body weight recorded for program '${program}'`);
    }
    return {
      date: entry.date.toISOString().slice(0, 10),
      weight: entry.weight,
      unit: entry.unit,
    };
  }
}
