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
import { BarbellComplex, BarbellComplexResponse, ComplexComponent } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CreateBarbellComplexDto } from './create-barbell-complex.dto';
import { modificationLiftId } from './lift-modification.util';
import { UpdateBarbellComplexDto } from './update-barbell-complex.dto';

function toBarbellComplexResponse(complex: BarbellComplex): BarbellComplexResponse {
  return {
    id: complex.id,
    name: complex.name,
    components: complex.components.map(({ lift, reps }) => ({ lift, reps })),
    createdAt: complex.createdAt.toISOString(),
  };
}

/**
 * The components, trimmed, each checked to name a catalog or custom lift. A component keeps the
 * name it was given rather than an id, since training maxes are found by a program's lift names
 * (`currentMaxLookup`), which any spelling of a catalog lift resolves to, but a custom lift's id
 * does not.
 */
async function checkedComponents(
  repos: Pick<RepositoryBundle, 'customLift'>,
  components: readonly ComplexComponent[],
): Promise<ComplexComponent[]> {
  const customLifts = await repos.customLift.list();
  return components.map(({ lift, reps }) => {
    const name = lift.trim();
    if (modificationLiftId(name, customLifts) === undefined) {
      throw new BadRequestException(`'${name}' is not a lift`);
    }
    return { lift: name, reps };
  });
}

/** A lifter's barbell complex definitions (#1495). A program row plans one as `complex:<id>`. */
@Controller('lifts/complexes')
export class BarbellComplexController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<BarbellComplexResponse[]> {
    const { barbellComplex } = await this.factory.forUser(user);
    return (await barbellComplex.list()).map(toBarbellComplexResponse);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateBarbellComplexDto, @CurrentUser() user: AuthUser): Promise<BarbellComplexResponse> {
    const repos = await this.factory.forUser(user);
    const components = await checkedComponents(repos, dto.components);
    return toBarbellComplexResponse(await repos.barbellComplex.create({ name: dto.name.trim(), components }));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBarbellComplexDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BarbellComplexResponse> {
    const repos = await this.factory.forUser(user);
    const components = dto.components && (await checkedComponents(repos, dto.components));
    const updated = await repos.barbellComplex.update(id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(components !== undefined ? { components } : {}),
    });
    return toBarbellComplexResponse(updated);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    const { barbellComplex } = await this.factory.forUser(user);
    await barbellComplex.delete(id);
  }
}
