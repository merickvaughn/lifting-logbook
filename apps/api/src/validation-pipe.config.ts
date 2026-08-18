import { ValidationPipeOptions } from '@nestjs/common';

/**
 * Single source of truth for the two flags that most commonly drift between
 * production and its test harnesses: `whitelist` and `forbidNonWhitelisted`. Import
 * this everywhere a harness constructs its own `new ValidationPipe(...)`, and
 * everywhere a `*.dto.spec.ts` calls class-validator's `validate()` directly, so
 * those two flags specifically can never silently diverge from main.ts again. Before
 * this existed, programs.e2e.spec.ts's harness omitted `forbidNonWhitelisted`, so its
 * HTTP-level tests could not actually prove an unrecognized request-body field is
 * rejected the way production does (found during #893's review).
 *
 * This is NOT a complete equivalence guarantee. `ValidationPipe` and a raw
 * `validate()` call are not the same operation even given identical options:
 * `ValidationPipe` forces `forbidUnknownValues: false` internally
 * (`@nestjs/common/pipes/validation.pipe.js`) and additionally runs `plainToClass`/
 * `classToPlain` around validation, while a bare `validate(dto, VALIDATION_PIPE_OPTIONS)`
 * call leaves `forbidUnknownValues` at class-validator's own default of `true` and
 * skips those transform steps entirely. If this object ever grows a key that isn't a
 * `ValidatorOptions` member (`transform`, `transformOptions`, `errorHttpStatusCode`,
 * …), every `validate()`-based DTO spec silently ignores it — there is no type error,
 * since `ValidationPipeOptions` is a superset of `ValidatorOptions`.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};
