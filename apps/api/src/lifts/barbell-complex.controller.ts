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
} from '@nestjs/common';
import { NamedLift, canonicalAliasFor, lookupLift } from '@lifting-logbook/core';
import { BarbellComplex, BarbellComplexResponse, ComplexComponent } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CreateBarbellComplexDto } from './create-barbell-complex.dto';
import { modificationLiftId } from './lift-modification.util';
import { UpdateBarbellComplexDto } from './update-barbell-complex.dto';

/** The name a component shows when its custom lift has been deleted. */
const DELETED_LIFT_NAME = 'Deleted lift';

function toBarbellComplexResponse(complex: BarbellComplex, customLifts: readonly NamedLift[]): BarbellComplexResponse {
  return {
    id: complex.id,
    name: complex.name,
    components: complex.components.map(({ lift, reps }) => {
      const { builtIn, custom } = lookupLift(lift, customLifts);
      return { lift, reps, name: custom?.name ?? (builtIn ? lift : DELETED_LIFT_NAME) };
    }),
    createdAt: complex.createdAt.toISOString(),
  };
}

/**
 * The components, each checked to name a catalog or custom lift. A catalog lift keeps the name it
 * was given, which any spelling of its max resolves from (`currentMaxLookup`). A custom lift is
 * stored by its id, where its training max is kept (#1291), and which a rename doesn't change.
 *
 * A lift already in `stored` (the complex's current components) is kept unchecked, so a complex
 * whose custom lift was deleted can still be renamed or have its other components edited.
 */
function checkedComponents(
  customLifts: readonly NamedLift[],
  components: readonly ComplexComponent[],
  stored: readonly ComplexComponent[] = [],
): ComplexComponent[] {
  return components.map(({ lift, reps }) => {
    const name = lift.trim();
    if (stored.some((c) => c.lift === name)) return { lift: name, reps };
    const { custom } = lookupLift(name, customLifts);
    if (modificationLiftId(name, customLifts) === undefined) {
      throw new BadRequestException(`'${name}' is not a lift`);
    }
    return { lift: custom?.id ?? name, reps };
  });
}

/**
 * A complex's name, trimmed. A lift's name is refused: the timer and a lift's settings find a lift
 * by the name a plan shows, so a complex called `Squat` would read as the lift. Case is ignored
 * (#1506), as it is for a custom lift's name, so `squat` is refused too.
 */
function checkedName(name: string, customLifts: readonly NamedLift[]): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (
    modificationLiftId(trimmed, customLifts) !== undefined ||
    canonicalAliasFor(trimmed) !== undefined ||
    customLifts.some((lift) => lift.name.toLowerCase() === lower)
  ) {
    throw new BadRequestException(`'${trimmed}' is a lift's name; give the complex another`);
  }
  return trimmed;
}

/** A lifter's barbell complex definitions (#1495). A program row plans one as `complex:<id>`. */
@Controller('lifts/complexes')
export class BarbellComplexController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<BarbellComplexResponse[]> {
    const { barbellComplex, customLift } = await this.factory.forUser(user);
    const [complexes, customLifts] = await Promise.all([barbellComplex.list(), customLift.list()]);
    return complexes.map((c) => toBarbellComplexResponse(c, customLifts));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateBarbellComplexDto, @CurrentUser() user: AuthUser): Promise<BarbellComplexResponse> {
    const repos = await this.factory.forUser(user);
    const customLifts = await repos.customLift.list();
    const name = checkedName(dto.name, customLifts);
    const components = checkedComponents(customLifts, dto.components);
    return toBarbellComplexResponse(await repos.barbellComplex.create({ name, components }), customLifts);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBarbellComplexDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BarbellComplexResponse> {
    const repos = await this.factory.forUser(user);
    const customLifts = await repos.customLift.list();
    const name = dto.name !== undefined ? checkedName(dto.name, customLifts) : undefined;
    let components: ComplexComponent[] | undefined;
    if (dto.components !== undefined) {
      const stored = (await repos.barbellComplex.list()).find((c) => c.id === id)?.components;
      components = checkedComponents(customLifts, dto.components, stored);
    }
    const updated = await repos.barbellComplex.update(id, {
      ...(name !== undefined ? { name } : {}),
      ...(components !== undefined ? { components } : {}),
    });
    return toBarbellComplexResponse(updated, customLifts);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    const { barbellComplex } = await this.factory.forUser(user);
    await barbellComplex.delete(id);
  }
}
