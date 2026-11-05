import { Writable } from 'stream';
import type { AddressInfo } from 'net';
import {
  Controller,
  Get,
  Module,
  NotFoundException,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { LoggerModule } from 'nestjs-pino';
import { pinoHttpOptions } from './app.module';

// Regression coverage for #1127: every API request log line recorded
// res.statusCode as null. pino-http applies the standard serializers before
// calling a custom one by default, and pinoHttpOptions' serializers apply them
// again, so the second pass saw an object with no headersSent. The specs that
// call pino(pinoHttpOptions) directly can't see this because they skip pino-http,
// so this one sends real requests through nestjs-pino, pino-http and Fastify.
interface RequestLogLine {
  msg: string;
  req?: { url: string; headers: Record<string, string> };
  res?: { statusCode: number | null; headers: Record<string, string> };
  err?: { type: string; message: string };
}

const lines: RequestLogLine[] = [];
const capture = new Writable({
  write(chunk: Buffer, _enc, callback) {
    lines.push(JSON.parse(chunk.toString()));
    callback();
  },
});

const RESPONSE_COOKIE = 'session=leaked-response-cookie';
const RESPONSE_REQUEST_ID = 'probe-response-id';

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(@Res({ passthrough: true }) reply: FastifyReply) {
    // On the raw response because the serializer reads res.getHeaders(), and
    // reply.header() values only reach Node through writeHead().
    reply.raw.setHeader('set-cookie', RESPONSE_COOKIE);
    reply.raw.setHeader('x-request-id', RESPONSE_REQUEST_ID);
    return { ok: true };
  }

  @Get('not-found')
  notFound() {
    throw new NotFoundException();
  }

  @Get('boom')
  boom() {
    throw new Error('probe failure');
  }
}

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: [pinoHttpOptions, capture] })],
  controllers: [ProbeController],
})
class ProbeModule {}

describe('request log lines through the real logging setup', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      ProbeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  // pino-http logs when the response finishes, which can land just after the
  // client has read the response.
  async function logLineFor(url: string) {
    const deadline = Date.now() + 2000;
    for (;;) {
      const line = lines.find((entry) => entry.req?.url === url && entry.res);
      if (line) return line;
      if (Date.now() > deadline) {
        throw new Error(`no request log line for ${url}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it.each([
    ['/probe/ok', 200, 'request completed'],
    ['/probe/not-found', 404, 'request completed'],
    ['/probe/boom', 500, 'request errored'],
  ])('records the status of GET %s as %i', async (url, status, msg) => {
    const response = await fetch(`${baseUrl}${url}`);
    expect(response.status).toBe(status);

    const line = await logLineFor(url);
    expect(line.res?.statusCode).toBe(status);
    expect(line.msg).toBe(msg);
  });

  it('still serializes the error on a failed request', async () => {
    const line = await logLineFor('/probe/boom');
    expect(line.err).toMatchObject({
      type: 'Error',
      message: 'failed with status code 500',
    });
  });

  it('keeps only allowlisted headers on a real request and response', async () => {
    const secrets = {
      authorization: 'Bearer known-jwt-value',
      'x-clerk-authorization': 'Bearer clerk-jwt-value',
      'x-novel-auth-token': 'novel-auth-token-value',
    };
    const url = '/probe/ok?headers=1';
    await fetch(`${baseUrl}${url}`, {
      headers: { ...secrets, 'user-agent': 'request-log-spec' },
    });

    const line = await logLineFor(url);
    const serialized = JSON.stringify(line);
    for (const value of [...Object.values(secrets), RESPONSE_COOKIE]) {
      expect(serialized).not.toContain(value);
    }
    expect(line.req?.headers['user-agent']).toBe('request-log-spec');
    expect(line.res?.headers['x-request-id']).toBe(RESPONSE_REQUEST_ID);
  });
});
