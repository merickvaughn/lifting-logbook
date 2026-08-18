import { ValidationPipeOptions } from '@nestjs/common';

/**
 * Single source of truth for the global ValidationPipe options.
 *
 * Shared between the real bootstrap (main.ts) and every test harness that either
 * constructs its own Nest app (programs.e2e.spec.ts and friends) or calls
 * class-validator's `validate()` directly (per-DTO `*.spec.ts` files) — so a test can
 * never silently diverge from what actually runs in production. Before this existed,
 * programs.e2e.spec.ts's harness omitted `forbidNonWhitelisted`, so its HTTP-level
 * tests could not actually prove that an unrecognized request-body field is rejected
 * the way production does (found during #893's review).
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};
