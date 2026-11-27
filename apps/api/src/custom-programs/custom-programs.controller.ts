import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CustomProgramResponse,
  CustomProgramSummaryResponse,
} from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { CustomProgramsRepository } from './custom-programs.repository';
import { CreateCustomProgramDto } from './create-custom-program.dto';
import { UpdateCustomProgramDto } from './update-custom-program.dto';

@Controller('programs/custom')
export class CustomProgramsController {
  // PrismaService is null when the API runs without a database (in-memory mode). Custom
  // programs are Prisma-only (docs/domain-model.md D17), so there are none to read and
  // nowhere to store a write (#1479).
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService | null) {}

  private repo(user: AuthUser) {
    if (!this.prisma) throw new ServiceUnavailableException('Custom programs need a database');
    // clientForRequest() yields the per-request RLS transaction client (GUC set) when one is
    // active, so these queries are RLS-scoped under the lifting_app role. See prisma.service.ts.
    return new CustomProgramsRepository(this.prisma.clientForRequest(), user.id);
  }

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<CustomProgramSummaryResponse[]> {
    if (!this.prisma) return [];
    return this.repo(user).list();
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCustomProgramDto,
  ): Promise<CustomProgramResponse> {
    return this.repo(user).create(dto);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<CustomProgramResponse> {
    if (!this.prisma) throw new NotFoundException(`Custom program ${id} not found`);
    return this.repo(user).get(id);
  }

  @Put(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCustomProgramDto,
  ): Promise<CustomProgramResponse> {
    return this.repo(user).update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.repo(user).delete(id);
  }
}
