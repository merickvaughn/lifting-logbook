import { BadRequestException, CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';

const ALLOWS_NON_CYCLE = 'allowsNonCycleProgram';

/**
 * Marks a lift-record write route as one a non-cycle workout's sets go through, so
 * {@link ReservedProgramGuard} lets the reserved program id reach it.
 */
export const AllowsNonCycleProgram = (): MethodDecorator & ClassDecorator => SetMetadata(ALLOWS_NON_CYCLE, true);

/**
 * The one guard that keeps the reserved `non-cycle` program id off every `:program` route
 * except the lift-record writes marked {@link AllowsNonCycleProgram} (proposal 2026-11-06,
 * decision 23). Most of those routes don't check the program, so without it `PATCH
 * training-maxes`, `POST switch` or macrocycle generation would accept it. It's what keeps
 * a non-cycle workout's sets away from a training max, since nothing that logs a set touches
 * one. Global, so a new `:program` route is covered without opting in.
 */
@Injectable()
export class ReservedProgramGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const params = context.switchToHttp().getRequest<{ params?: Record<string, string | undefined> }>().params;
    if (params?.['program'] !== NON_CYCLE_PROGRAM) return true;
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOWS_NON_CYCLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;
    throw new BadRequestException({
      statusCode: 400,
      code: 'program-reserved',
      message: `'${NON_CYCLE_PROGRAM}' holds workouts outside any program, and can't be used here.`,
      error: 'Bad Request',
    });
  }
}
