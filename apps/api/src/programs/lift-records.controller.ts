import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  CreateLiftRecordRequest,
  ImportLiftRecordsResponse,
  LiftRecordResponse,
  SkippedRecord,
  UpdateLiftRecordRequest,
} from '@lifting-logbook/types';
import {
  DEFAULT_SLOT_MAP,
  classifyImportRows,
  formatDateYYYYMMDD,
  liftRecordNaturalKey,
  parseCsvText,
  parseLiftRecords,
  toUTCMidnight,
  validateLiftImport,
} from '@lifting-logbook/core';
import { FastifyRequest } from 'fastify';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { MAX_IMPORT_ROWS, readUploadedCsv } from './import-file.util';
import { toLiftRecordResponse } from './mappers';

@Controller('programs/:program')
export class LiftRecordsController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
  ) {}

  @Get('lift-records')
  async getLiftRecords(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftRecordResponse[]> {
    const { liftRecord, cycleDashboard } = await this.factory.forUser(user);
    const dashboard = await cycleDashboard.getCycleDashboard(program);
    const records = await liftRecord.getLiftRecords(program, dashboard.cycleNum);
    return records.map(toLiftRecordResponse);
  }

  @Post('lift-records')
  @HttpCode(HttpStatus.CREATED)
  async createLiftRecord(
    @Param('program') program: string,
    @Body() body: CreateLiftRecordRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftRecordResponse> {
    const { liftRecord, cycleScheduledWorkout } = await this.factory.forUser(user);

    let effectiveDate: Date;
    if (body.date) {
      effectiveDate = new Date(body.date);
    } else {
      const scheduled = await cycleScheduledWorkout.getScheduledWorkouts(program, body.cycleNum);
      const match = scheduled.find((s) => s.workoutNum === body.workoutNum);
      // Bare `new Date()` is the one fallback source not already UTC-midnight by
      // construction (an explicit body.date parses as UTC midnight per spec; a
      // scheduled date is `@db.Date`, no time component) — normalize so the
      // stored date always round-trips exactly through the YYYYMMDD id/key
      // encoding (issue #884).
      effectiveDate = match?.scheduledDate ?? toUTCMidnight(new Date());
    }

    const record = {
      program,
      cycleNum: body.cycleNum,
      workoutNum: body.workoutNum,
      date: effectiveDate,
      lift: body.lift,
      setNum: body.setNum,
      weight: body.weight,
      reps: body.reps,
      notes: body.notes ?? '',
    };
    const written = await liftRecord.appendLiftRecords(program, [record]);
    if (written === 0) {
      // Same root cause as issue #884's import-path fix: skipDuplicates silently
      // no-ops when a record's natural key already exists. Surface that instead
      // of returning 201 for a write that never happened.
      throw new ConflictException(
        `A lift record already exists for ${record.lift}, cycle ${record.cycleNum}, ` +
          `workout ${record.workoutNum}, set ${record.setNum} on ${formatDateYYYYMMDD(record.date)}.`,
      );
    }
    return toLiftRecordResponse(record);
  }

  /**
   * Imports historical lift records from a CSV file.
   *
   * Validation is all-or-nothing: if any row fails, the entire upload is rejected
   * with 400 and no records are written.
   *
   * Lift abbreviations (e.g. "Bench P.") are resolved to canonical lift IDs
   * (e.g. "bench-press") via the DEFAULT_SLOT_MAP. Programs do not restrict which
   * lifts may be imported — all lifts present in the slot map are accepted for any
   * program. (Preloaded template programs become custom programs when edited; custom
   * programs have no lift restrictions.)
   *
   * Rows whose natural key (cycleNum, workoutNum, date, lift, setNum) already exist
   * for the program — or that repeat an earlier row's key within this same file —
   * are skipped and reported in the `skipped` response field. `written`/`skipped`
   * both come from one up-front classification pass (issue #884), so a same-key
   * duplicate within the file is reported rather than silently vanishing, and the
   * count no longer depends on the database's within-statement `ON CONFLICT`
   * ordering to decide which of two colliding rows survives.
   */
  @Post('lift-records/import')
  @HttpCode(HttpStatus.CREATED)
  async importLiftRecords(
    @Param('program') program: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportLiftRecordsResponse> {
    const csvText = await readUploadedCsv(req);
    const table = parseCsvText(csvText);
    const parsed = parseLiftRecords(table);

    if (parsed.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(
        `Import exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. ` +
          `Split the file into smaller batches.`,
      );
    }

    const { valid, errors } = validateLiftImport(parsed, DEFAULT_SLOT_MAP);
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Validation failed', errors });
    }

    // Stamp each record with the route program before persisting, and pair each
    // with its 1-based CSV row number so a skip can be reported against the
    // original file position after classification (which may reorder nothing but
    // does filter).
    const rows = valid.map((r, i) => ({ r: { ...r, program }, row: i + 1 }));

    const { liftRecord } = await this.factory.forUser(user);
    const dupKeys = new Set(
      (await liftRecord.findExistingRecords(program, rows.map(({ r }) => r))).map(
        liftRecordNaturalKey,
      ),
    );

    const classified = [
      ...classifyImportRows(
        rows,
        ({ r }) => liftRecordNaturalKey(r),
        (_x, k) => (dupKeys.has(k) ? 'skip' : 'create'),
      ),
    ];

    // `written` comes directly from the database's createMany count so it is
    // accurate even if a concurrent import caused additional rows to be skipped.
    const written = await liftRecord.appendLiftRecords(
      program,
      classified.filter((c) => c.kind === 'create').map((c) => c.row.r),
    );

    const skipped: SkippedRecord[] = classified
      .filter((c) => c.kind === 'skip')
      .map((c) => ({ row: c.row.row, naturalKey: c.key }));

    return { written, skipped };
  }

  @Patch('lift-records/:id')
  async updateLiftRecord(
    @Param('program') program: string,
    @Param('id') id: string,
    @Body() body: UpdateLiftRecordRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftRecordResponse> {
    const { liftRecord } = await this.factory.forUser(user);
    const updated = await liftRecord.updateLiftRecord(program, id, body);
    if (!updated) {
      throw new NotFoundException(
        `Lift record '${id}' not found for program '${program}'`,
      );
    }
    return toLiftRecordResponse(updated);
  }
}
