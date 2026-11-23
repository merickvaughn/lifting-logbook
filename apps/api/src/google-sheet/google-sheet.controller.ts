import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { GoogleSheetLinkView, GoogleSheetService, UnlinkResult } from './google-sheet.service';

export class GoogleSheetCallbackDto {
  @IsString() @MinLength(1) @MaxLength(2048) code!: string;
  @IsString() @MinLength(1) @MaxLength(256) state!: string;
}

/**
 * Link a Google Sheet (#1432, ADR-047). Every route is Clerk-authenticated by the global guard.
 * Every route skips the per-request RLS transaction: the service calls Google and KMS between
 * short transactions of its own, so no connection is held across a network call and each write
 * commits on its own (a taken state stays taken when the callback then fails).
 */
@Controller('integrations/google-sheet')
export class GoogleSheetController {
  constructor(private readonly service: GoogleSheetService) {}

  @Get()
  @SkipRlsTransaction()
  get(@CurrentUser() user: AuthUser): Promise<GoogleSheetLinkView> {
    return this.service.get(user);
  }

  @Post('authorize')
  @HttpCode(200)
  @SkipRlsTransaction()
  authorize(@CurrentUser() user: AuthUser): Promise<{ url: string }> {
    return this.service.authorize(user);
  }

  @Post('callback')
  @HttpCode(200)
  @SkipRlsTransaction()
  callback(@CurrentUser() user: AuthUser, @Body() dto: GoogleSheetCallbackDto): Promise<GoogleSheetLinkView> {
    return this.service.callback(user, dto.code, dto.state);
  }

  @Post('sheet')
  @HttpCode(200)
  @SkipRlsTransaction()
  createSheet(@CurrentUser() user: AuthUser): Promise<GoogleSheetLinkView> {
    return this.service.createSheet(user);
  }

  @Delete()
  @SkipRlsTransaction()
  unlink(@CurrentUser() user: AuthUser): Promise<UnlinkResult> {
    return this.service.unlink(user);
  }
}
