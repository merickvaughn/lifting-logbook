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
  ImportLiftRecordsResponse,
  LiftRecordResponse,
} from '@lifting-logbook/types';
import {
  buildLiftRecordId,
  buildSkippedDetail,
  classifyImportRows,
  liftRecordNaturalKey,
  pairWithRowNumber,
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
import { CreateLiftRecordDto } from './create-lift-record.dto';
import { UpdateLiftRecordDto } from './update-lift-record.dto';
import { MAX_IMPORT_ROWS, readUploadedCsv } from './import-file.util';
import { toLiftRecordResponse } from './mappers';
import { effectiveSlotMapFor } from './effective-slot-map.util';
import { RlsTxTimeout } from '../adapters/prisma/rls-context';
import { IMPORT_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';

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
    @Body() body: CreateLiftRecordDto,
    @CurrentUser() user: AuthUser,
  ): Promise<LiftRecordResponse> {
    // `body.program` is unused by the write itself (the route param is authoritative
    // below) but is now a declared, validated part of the accepted contract
    // (CreateLiftRecordDto) — silently discarding a *conflicting* value would be
    // worse than the pre-DTO state of ignoring an unvalidated one: a client bug (a
    // stale route, a mis-wired component) could write real training data into the
    // wrong program with a 201 giving no indication anything was wrong (issue #893
    // review round 3).
    if (body.program !== undefined && body.program !== program) {
      throw new BadRequestException(
        `program in the request body ('${body.program}') does not match the route parameter ('${program}')`,
      );
    }

    const { liftRecord, cycleScheduledWorkout } = await this.factory.forUser(user);

    let effectiveDate: Date;
    if (body.date) {
      // `CreateLiftRecordDto.date` is validated as a bare calendar date (issue #893).
      // Normalize unconditionally rather than trusting the caller to send UTC
      // midnight: the stored date must round-trip exactly through the YYYYMMDD
      // id/key encoding (issue #884), or the record becomes unreachable by a later
      // PATCH.
      effectiveDate = toUTCMidnight(new Date(body.date));
      // Last-resort guard, independent of whatever the DTO's decorators do or don't
      // catch: #893's review found that class-validator's `@IsDateString`/`@Matches`
      // combination on `body.date` still has edge cases (verified: ISO 8601 week-date
      // strings like "2026-W05" pass validation but `new Date(...)` can't parse
      // them). An `Invalid Date` reaching `appendLiftRecords` either crashes later
      // with an opaque `RangeError: Invalid time value` (from `.toISOString()` on the
      // conflict path below) or writes a record no id/key can ever address again —
      // surface a clean 400 here instead, regardless of which upstream validator gap
      // let it through. Scoped to this branch only: a NaN here can only originate
      // from client-supplied `body.date`, so a 400 correctly blames the request. The
      // scheduled-date branch below has no such guard — a bad `scheduledDate` would
      // be a server-side data defect, not something a 400 (which tells the client to
      // fix input it never sent) should be blamed on.
      if (Number.isNaN(effectiveDate.getTime())) {
        throw new BadRequestException('date must be a valid calendar date');
      }
    } else {
      const scheduled = await cycleScheduledWorkout.getScheduledWorkouts(program, body.cycleNum);
      const match = scheduled.find((s) => s.workoutNum === body.workoutNum);
      // `scheduledDate` is `@db.Date` (no time component) so it's already
      // UTC-midnight-equivalent, but normalize it too for defense in depth —
      // the bare `new Date()` fallback is the one source with no upstream
      // guarantee at all.
      effectiveDate = toUTCMidnight(match?.scheduledDate ?? new Date());
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
      // of returning 201 for a write that never happened — but this request
      // carries no idempotency key, so a genuine retry of an earlier write whose
      // response was lost (timeout, dropped connection, backgrounded tab) is
      // indistinguishable from a real duplicate-submission attempt except by
      // comparing payloads: if the already-stored record's mutable fields
      // exactly match what this request is trying to write, treat it as that
      // retry succeeding (the record already reflects the caller's intent)
      // rather than leaving the client stuck on a conflict it cannot resolve.
      // A payload that collides on the key but differs in content is a genuine
      // conflict and still 409s.
      const existing = (await liftRecord.getLiftRecords(program, record.cycleNum)).find(
        (r) =>
          r.workoutNum === record.workoutNum &&
          r.lift === record.lift &&
          r.setNum === record.setNum &&
          r.date.getTime() === record.date.getTime(),
      );
      if (
        existing &&
        existing.weight === record.weight &&
        existing.reps === record.reps &&
        existing.notes === record.notes
      ) {
        return toLiftRecordResponse(existing);
      }
      const existingId = existing ? buildLiftRecordId(program, existing) : null;
      throw new ConflictException(
        `A lift record already exists for ${record.lift}, cycle ${record.cycleNum}, ` +
          `workout ${record.workoutNum}, set ${record.setNum} on ${record.date.toISOString().slice(0, 10)}` +
          (existingId
            ? `. Update it with PATCH /programs/${program}/lift-records/${existingId} instead.`
            : '.'),
      );
    }
    return toLiftRecordResponse(record);
  }

  /**
   * Imports historical lift records from a CSV file.
   *
   * Validation is all-or-nothing: if any row fails, the entire upload is rejected
   * with 400 and no records are written. Unlike the Smart Import Wizard
   * (ImportController), this endpoint has no preview/remap step — an unrecognized
   * lift name cannot be interactively resolved here.
   *
   * Lift abbreviations (e.g. "Bench P.") are resolved to canonical lift IDs
   * (e.g. "bench-press") via a slot map built fresh per request:
   * DEFAULT_SLOT_MAP plus the calling user's own custom lifts, by exact name
   * (effectiveSlotMapFor / buildEffectiveSlotMap — issue #911). DEFAULT_SLOT_MAP
   * wins on a name collision, so a custom lift can never shadow a canonical
   * abbreviation. Programs do not restrict which lifts may be imported — all
   * lifts present in the effective slot map are accepted for any program.
   * (Preloaded template programs become custom programs when edited; custom
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
  // Same import transaction budget as ImportController's own import path (#532) — this
  // endpoint runs the identical shape of work (bulk validate + createMany, now also an
  // effectiveSlotMapFor query added by #911) inside the same per-request RLS transaction,
  // so it needs the same widened window rather than falling through to the 15s default
  // (#911 review, eighth pass).
  @RlsTxTimeout(IMPORT_TX_TIMEOUT_MS)
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

    // Hoisted ahead of validation (was previously fetched only after it) so the slot
    // map can recognize this user's custom lifts by name, not just the built-in
    // DEFAULT_SLOT_MAP (#911) — this endpoint has no interactive remap step of its
    // own, so an exact-name match against an existing custom lift is the only way a
    // custom lift can ever resolve here.
    const repos = await this.factory.forUser(user);
    const { liftRecord } = repos;

    const { valid, errors } = validateLiftImport(parsed, await effectiveSlotMapFor(repos));
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Validation failed', errors });
    }

    // Stamp each record with the route program before persisting, and pair each
    // with its 1-based CSV row number (via pairWithRowNumber, shared with the
    // Smart Import wizard's liftRecordsHandler — issues #891/#896) so a skip can
    // be reported against the original file position after classification
    // (which may reorder nothing but does filter).
    const rows = pairWithRowNumber(valid.map((r) => ({ ...r, program })));

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

    const skipped = buildSkippedDetail(classified);

    return { written, skipped };
  }

  @Patch('lift-records/:id')
  async updateLiftRecord(
    @Param('program') program: string,
    @Param('id') id: string,
    @Body() body: UpdateLiftRecordDto,
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
