import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { Public } from '../auth/public.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { GoogleOidcVerifier, IOidcVerifier } from './oidc-verifier';
import { MIRROR_PATH } from './sheet-mirror-queue';
import { SupplementSheetMirrorService } from './supplement-sheet-mirror.service';

export const OIDC_VERIFIER = Symbol('OIDC_VERIFIER');

export class SheetMirrorTaskDto {
  @IsString() @MinLength(1) @MaxLength(128) userId!: string;
}

/**
 * The only caller is Cloud Tasks (ADR-047, decision 18). ADR-032 made the API publicly invokable,
 * so Cloud Run IAM can't gate the route: this guard verifies the task's Google-signed OIDC token,
 * its audience (the API's own URL) and its verified `email` (the `sheet-mirror-tasks` account). It
 * then sets the request's user to the task's, so the RLS interceptor confines the run to that user.
 */
@Injectable()
export class SheetMirrorCallerGuard implements CanActivate {
  constructor(@Inject(OIDC_VERIFIER) private readonly verifier: IOidcVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      body?: { userId?: unknown };
      user?: AuthUser;
    }>();
    const header = request.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    let allowed: boolean;
    try {
      allowed = await this.verifier.verify(token, {
        audience: process.env.SHEET_MIRROR_API_URL?.replace(/\/$/, ''),
        email: process.env.SHEET_MIRROR_TASKS_SA_EMAIL,
      });
    } catch {
      // Google's signing keys couldn't be fetched: not the caller's fault, so Cloud Tasks retries.
      // fallback-covered-by: apps/api/src/supplement-sheet-mirror/supplement-sheet-mirror.e2e.spec.ts
      throw new ServiceUnavailableException();
    }
    if (!allowed) throw new UnauthorizedException();
    const userId = request.body?.userId;
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
      throw new BadRequestException('userId is required');
    }
    request.user = { id: userId, email: '', provider: 'sheet-mirror' };
    return true;
  }
}

/** The internal endpoint Cloud Tasks calls (#1443). Supplement writes and Sync now enqueue it (#1444). */
@Controller(MIRROR_PATH.slice(1))
export class SupplementSheetMirrorController {
  constructor(private readonly service: SupplementSheetMirrorService) {}

  @Post()
  @Public()
  @UseGuards(SheetMirrorCallerGuard)
  @HttpCode(204)
  @SkipRlsTransaction()
  async run(
    @CurrentUser() user: AuthUser,
    @Body() _dto: SheetMirrorTaskDto,
    @Headers('x-cloudtasks-taskretrycount') retryCount?: string,
  ): Promise<void> {
    await this.service.run(user, Number.parseInt(retryCount ?? '0', 10) || 0);
  }
}

export const defaultOidcVerifier = () => new GoogleOidcVerifier();
