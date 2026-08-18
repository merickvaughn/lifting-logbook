import { Body, Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { BodyWeightEntry, BodyWeightResponse } from '@lifting-logbook/types';
import { IBodyWeightRepository } from '../ports/IBodyWeightRepository';
import { BODY_WEIGHT_REPOSITORY } from '../ports/tokens';
import { RecordBodyWeightDto } from './record-body-weight.dto';

@Controller('programs/:program')
export class BodyWeightController {
  constructor(
    @Inject(BODY_WEIGHT_REPOSITORY)
    private readonly bodyWeightRepo: IBodyWeightRepository,
  ) {}

  @Post('body-weight')
  @HttpCode(HttpStatus.CREATED)
  async recordBodyWeight(
    @Param('program') program: string,
    @Body() body: RecordBodyWeightDto,
  ): Promise<void> {
    const entry: BodyWeightEntry = {
      date: new Date(body.date),
      weight: body.weight,
      unit: body.unit,
    };
    await this.bodyWeightRepo.recordBodyWeight(program, entry);
  }

  @Get('body-weight/latest')
  async getLatestBodyWeight(
    @Param('program') program: string,
  ): Promise<BodyWeightResponse> {
    const entry = await this.bodyWeightRepo.getLatestBodyWeight(program);
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
