import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { CsvParseError, parseCsvText, SpreadsheetCell } from '@lifting-logbook/core';
import { FastifyRequest } from 'fastify';

/**
 * Maximum rows accepted per import. Bounds the stored-set lookup (`findStoredSets`, which
 * queries in chunks of dates) and memory use during parsing.
 */
export const MAX_IMPORT_ROWS = 5_000;

/** Upload size limit for one import file; `main.ts` registers multipart with it. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Most form fields one Smart Import request may carry. A commit reads five (`excludeKeys`,
 * `liftOverrides`, `today`, `breakdown`, `notes`). multipart buffers every field in memory,
 * so the count is what bounds that memory. It is counted here rather than through multipart's
 * `limits.fields`, which destroys the file stream when it trips before the file arrives and
 * leaves a bare `ERR_STREAM_PREMATURE_CLOSE` (a 500) instead of a status code (#1146).
 */
export const MAX_IMPORT_FIELDS = 5;

/** An uploaded file as `@fastify/multipart` exposes it. */
interface UploadedFile {
  toBuffer(): Promise<Buffer>;
  file: { truncated: boolean };
}

/** One part of a multipart request, from `req.parts()`. */
type MultipartPart =
  | ({ type: 'file' } & UploadedFile)
  | { type: 'field'; fieldname: string; value: unknown; valueTruncated: boolean };

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
    file(): Promise<UploadedFile | null>;
  }).file();
  if (!file) throw new BadRequestException('No file uploaded');
  return csvTextOf(file);
}

/**
 * Reads the Smart Import form: the CSV file plus its text fields, in either order
 * (#1121). `req.file()` stops at the file, so it would miss a field sent after it.
 *
 * The field size limit is set here so it holds however multipart was registered. Each
 * entry in a field names one row of the file, so the file's own size limit is ample.
 * multipart cuts an over-long field short without raising an error, which for an
 * exclusion list would mean committing excluded rows, so a truncated field is a 413.
 * That check waits until the loop ends so the file is still consumed when the field
 * arrives first.
 */
export async function readImportForm(
  req: FastifyRequest,
): Promise<{ csvText: string; fields: Map<string, string> }> {
  const parts = (req as FastifyRequest & {
    parts(opts: { limits: { fieldSize: number } }): AsyncIterable<MultipartPart>;
  }).parts({ limits: { fieldSize: MAX_IMPORT_FILE_BYTES } });

  let csvText: string | null = null;
  const fields = new Map<string, string>();
  const truncated: string[] = [];
  try {
    for await (const part of parts) {
      if (part.type === 'file') {
        csvText = await csvTextOf(part);
      } else if (fields.size + truncated.length >= MAX_IMPORT_FIELDS) {
        throw new PayloadTooLargeException(`More than ${MAX_IMPORT_FIELDS} form fields`);
      } else if (part.valueTruncated) {
        truncated.push(part.fieldname);
      } else {
        fields.set(part.fieldname, String(part.value));
      }
    }
  } catch (err) {
    // multipart's own client errors (a second file, say) carry a 4xx statusCode, but
    // only an HttpException reaches the client as anything but a 500.
    const { statusCode, message } = err as { statusCode?: number; message: string };
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      throw new HttpException(message, statusCode);
    }
    throw err;
  }
  if (truncated.length > 0) {
    throw new PayloadTooLargeException(`${truncated.join(', ')} exceeds the 5 MB limit`);
  }
  if (csvText === null) throw new BadRequestException('No file uploaded');
  return { csvText, fields };
}

/** Parses an uploaded file's text; text that isn't valid CSV is a 400 naming the line (#1497). */
export function parseUploadedCsv(csvText: string): SpreadsheetCell[][] {
  try {
    return parseCsvText(csvText);
  } catch (err) {
    if (err instanceof CsvParseError) throw new BadRequestException(err.message);
    throw err;
  }
}

async function csvTextOf(file: UploadedFile): Promise<string> {
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
