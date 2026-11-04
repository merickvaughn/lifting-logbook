import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

/**
 * Maximum rows accepted per import. Guards against unbounded OR queries in
 * findExistingRecords and excessive memory usage during parsing.
 */
export const MAX_IMPORT_ROWS = 5_000;

/** Upload size limit for one import file; `main.ts` registers multipart with it. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Reads a single uploaded CSV file from a multipart request and returns its text.
 *
 * Shared by the legacy lift-records importer and the unified Smart Import
 * endpoint (#477). Surfaces the same caps: missing file → 400, oversize file →
 * 413 (whether `@fastify/multipart` throws `FST_REQ_FILE_TOO_LARGE` or truncates).
 */
export async function readUploadedCsv(req: FastifyRequest): Promise<string> {
  // req.file() is provided by @fastify/multipart registered in main.ts.
  const file = await (req as FastifyRequest & {
    file(): Promise<{ toBuffer(): Promise<Buffer>; file: { truncated: boolean } } | null>;
  }).file();
  if (!file) throw new BadRequestException('No file uploaded');

  let csvBuffer: Buffer;
  try {
    csvBuffer = await file.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new PayloadTooLargeException('File exceeds the 5 MB upload limit');
    }
    throw err;
  }
  if (file.file.truncated) {
    throw new PayloadTooLargeException('File exceeds the 5 MB upload limit');
  }

  return csvBuffer.toString('utf-8');
}
