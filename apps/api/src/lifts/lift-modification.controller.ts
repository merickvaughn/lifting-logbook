import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  LiftModification,
  LiftModificationResponse,
  LiftModificationsByLiftResponse,
} from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CreateLiftModificationDto } from './create-lift-modification.dto';
import { modificationLiftId, modificationLiftIds } from './lift-modification.util';
import { UpdateLiftModificationDto } from './update-lift-modification.dto';

function toLiftModificationResponse(modification: LiftModification): LiftModificationResponse {
  return {
    id: modification.id,
    lift: modification.lift,
    name: modification.name,
    description: modification.description,
    maxMode: modification.maxMode,
    createdAt: modification.createdAt.toISOString(),
  };
}

@Controller('lifts/modifications')
export class LiftModificationController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  /**
   * The user's modifications, leaving out archived ones. `?lift=` narrows to one lift under any
   * name it resolves by, and is empty for a name that resolves to nothing.
   */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('lift') lift?: string,
  ): Promise<LiftModificationResponse[]> {
    const { customLift, liftModification } = await this.factory.forUser(user);
    const liftIds = lift === undefined ? undefined : modificationLiftIds(lift, await customLift.list());
    const modifications = await liftModification.list();
    return modifications
      .filter((m) => !m.archivedAt && (liftIds === undefined || liftIds.has(m.lift)))
      .map(toLiftModificationResponse);
  }

  /**
   * Several lifts' modifications in one request, for the workout logger (#1242): `?lift=` once per
   * lift, each answered under the name it was asked by and resolved as the single-lift form does.
   * Reads the user's custom lifts and modifications once, however many lifts are asked.
   */
  @Get('by-lift')
  async listByLift(
    @CurrentUser() user: AuthUser,
    @Query('lift') lift?: string | string[],
  ): Promise<LiftModificationsByLiftResponse> {
    const names = lift === undefined ? [] : [lift].flat();
    if (names.length === 0) return {};
    const { customLift, liftModification } = await this.factory.forUser(user);
    const customLifts = await customLift.list();
    const listed = (await liftModification.list()).filter((m) => !m.archivedAt);
    // `Object.fromEntries` makes each name an own property, so a name like `__proto__` is just a key.
    return Object.fromEntries(
      names.map((name) => {
        const liftIds = modificationLiftIds(name, customLifts);
        return [name, listed.filter((m) => liftIds.has(m.lift)).map(toLiftModificationResponse)];
      }),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateLiftModificationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftModificationResponse> {
    const { customLift, liftModification } = await this.factory.forUser(user);
    const lift = modificationLiftId(dto.lift, await customLift.list());
    if (lift === undefined) {
      throw new BadRequestException(`'${dto.lift}' is not a lift`);
    }
    const created = await liftModification.create({
      lift,
      name: dto.name,
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.maxMode !== undefined ? { maxMode: dto.maxMode } : {}),
    });
    return toLiftModificationResponse(created);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateLiftModificationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftModificationResponse> {
    const { liftModification } = await this.factory.forUser(user);
    return toLiftModificationResponse(await liftModification.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    const { liftModification } = await this.factory.forUser(user);
    await liftModification.delete(id);
  }
}
