import {
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
} from '@nestjs/common';
import { ALL_SLOT_MAP_ALIASES } from '@lifting-logbook/core';
import { CustomLift, CustomLiftResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { UpdateCustomLiftPatch } from '../ports/ICustomLiftRepository';
import { CustomLiftConflictError } from '../ports/errors';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CreateCustomLiftDto } from './create-custom-lift.dto';
import { UpdateCustomLiftDto } from './update-custom-lift.dto';

function toCustomLiftResponse(lift: CustomLift): CustomLiftResponse {
  return {
    id: lift.id,
    name: lift.name,
    classification: lift.classification,
    movementProfile: lift.movementProfile,
    isBodyweightComponent: lift.isBodyweightComponent ?? false,
    isCustom: true,
    createdAt: lift.createdAt.toISOString(),
  };
}

@Controller('lifts')
export class CustomLiftController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Get('custom')
  async list(@CurrentUser() user: AuthUser): Promise<CustomLiftResponse[]> {
    const { customLift } = await this.factory.forUser(user);
    const lifts = await customLift.list();
    return lifts.map(toCustomLiftResponse);
  }

  @Post('custom')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateCustomLiftDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CustomLiftResponse> {
    // A custom lift name that case-insensitively matches a built-in canonical
    // alias (e.g. "squat" vs. "Squat") must never be allowed to register: it
    // would create successfully (custom-lift name uniqueness is scoped to
    // this user and is itself exact-case), but buildEffectiveSlotMap always
    // lets DEFAULT_SLOT_MAP win on an exact-case collision, so a case-variant
    // custom lift is never actually reachable by that name at import time —
    // silently fragmenting that lift's history across two ids the moment a
    // user (or a future caller of this API that isn't this PR's own UI, which
    // has its own client-side guard) creates one. Reject up front, the same
    // way a same-user duplicate custom-lift name already 409s (issue #911 review).
    const lowerName = dto.name.toLowerCase();
    if (ALL_SLOT_MAP_ALIASES.some((alias) => alias.toLowerCase() === lowerName)) {
      throw new CustomLiftConflictError(dto.name);
    }

    const { customLift } = await this.factory.forUser(user);
    const created = await customLift.create({
      name: dto.name,
      classification: dto.classification,
      ...(dto.movementProfile !== undefined ? { movementProfile: dto.movementProfile } : {}),
      ...(dto.isBodyweightComponent !== undefined
        ? { isBodyweightComponent: dto.isBodyweightComponent }
        : {}),
    });
    return toCustomLiftResponse(created);
  }

  @Patch('custom/:id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomLiftDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CustomLiftResponse> {
    // Same guard as create() — a rename to a name that case-insensitively
    // shadows a canonical alias has the identical fragmentation risk (#911 review).
    if (dto.name !== undefined) {
      const lowerName = dto.name.toLowerCase();
      if (ALL_SLOT_MAP_ALIASES.some((alias) => alias.toLowerCase() === lowerName)) {
        throw new CustomLiftConflictError(dto.name);
      }
    }

    const { customLift } = await this.factory.forUser(user);
    const patch: UpdateCustomLiftPatch = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.classification !== undefined) patch.classification = dto.classification;
    if (dto.movementProfile !== undefined) patch.movementProfile = dto.movementProfile;
    if (dto.isBodyweightComponent !== undefined) {
      patch.isBodyweightComponent = dto.isBodyweightComponent;
    }
    const updated = await customLift.update(id, patch);
    return toCustomLiftResponse(updated);
  }

  @Delete('custom/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    const { customLift } = await this.factory.forUser(user);
    await customLift.delete(id);
  }
}
