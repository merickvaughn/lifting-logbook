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
import { canonicalAliasFor } from '@lifting-logbook/core';
import { CustomLift, CustomLiftResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { UpdateCustomLiftPatch } from '../ports/ICustomLiftRepository';
import { ReservedLiftNameConflictError } from '../ports/errors';
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
    // has its own client-side guard) creates one. Reject up front, distinctly
    // from a same-user duplicate custom-lift name (which 409s too, but as a
    // real conflict against a lift that actually exists) — see
    // ReservedLiftNameConflictError's own comment (issue #911 review).
    // dto.name is already trimmed by the DTO's own @Transform before this
    // runs — see create-custom-lift.dto.ts for why leading/trailing
    // whitespace must not be allowed to slip past this guard.
    if (canonicalAliasFor(dto.name) !== undefined) {
      throw new ReservedLiftNameConflictError(dto.name);
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
    // shadows a canonical alias has the identical fragmentation risk (#911
    // review). typeof dto.name === 'string', not a bare !== undefined check:
    // UpdateCustomLiftDto.name's @IsOptional() skips ALL of class-validator's
    // checks (including @IsString()) for both undefined AND null, so a
    // request body of {"name": null} reaches here with dto.name === null,
    // and null !== undefined is true — canonicalAliasFor(null) would then
    // throw calling .toLowerCase() on it, an unhandled 500 with no filter
    // registered to catch a bare TypeError. This pre-existing DTO gap
    // (accepting null at all) predates this guard and stays out of scope
    // here — patch.name below still silently stores it, matching this
    // method's behavior before #911 touched this file — but this guard is
    // the first code in the method to actually ACT on that loose input, so
    // it must not be the thing that turns it into a crash (#911 review,
    // fifth pass).
    if (typeof dto.name === 'string' && canonicalAliasFor(dto.name) !== undefined) {
      throw new ReservedLiftNameConflictError(dto.name);
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
