// MUST be the first import. otel.ts starts the OpenTelemetry NodeSDK, which
// uses require-in-the-middle to patch http, pg, @prisma/client, etc. Any module
// that pulls those in before this line will not be instrumented. Do not let an
// import sorter (ESLint sort-imports / Prettier organize-imports) move it.
import './otel';
import 'reflect-metadata';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { resolveCorsOrigins } from './cors.config';
import { DomainConflictFilter } from './programs/conflict.filter';
import { DomainNotFoundFilter } from './programs/not-found.filter';
import { PrismaTransactionTimeoutFilter } from './programs/transaction-timeout.filter';
import { VALIDATION_PIPE_OPTIONS } from './validation-pipe.config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: false },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(multipart as any, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.useLogger(app.get(Logger));
  // PrismaTransactionTimeoutFilter extends BaseExceptionFilter, so it needs the
  // HTTP adapter to delegate non-P2028 Prisma errors to the framework default.
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(
    new DomainNotFoundFilter(),
    new DomainConflictFilter(),
    new PrismaTransactionTimeoutFilter(httpAdapter),
  );
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  // Browser → API calls are cross-origin (ADR-028/ADR-032): the web app calls the API's
  // external URL directly from the browser, so without these CORS headers the browser blocks
  // every client-side write. enableCors registers @fastify/cors, which also answers the
  // preflight OPTIONS. See cors.config.ts for the allowlist and its rationale.
  app.enableCors({
    origin: resolveCorsOrigins(),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 3600,
  });
  const port = parseInt(process.env.PORT ?? '3004', 10);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
