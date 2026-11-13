import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
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
  MACROCYCLE_ID_HEADER,
  NON_CYCLE_PROGRAM,
} from '@lifting-logbook/types';
import {
  LiftRecord,
  buildLiftRecordId,
  buildSkippedDetail,
  liftRecordLabel,
  liftRecordNaturalKey,
  parseCsvText,
  parseLiftRecordId,
  parseLiftRecords,
  toUTCMidnight,
  validateLiftImport,
  withImportProgram,
  withModifications,
  withOccurrence,
} from '@lifting-logbook/core';
import { FastifyRequest } from 'fastify';
import { CurrentUser } from '../auth/current-user.decorator';
import { assertSetModifications, modificationNamesFor } from '../lifts/lift-modification.util';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { CreateLiftRecordDto } from './create-lift-record.dto';
import { MAX_WORKOUT_NUM } from './lift-record.limits';
import { assertNonCycleSet } from './non-cycle.util';
import { AllowsNonCycleProgram } from './reserved-program.guard';
import { UpdateLiftRecordDto } from './update-lift-record.dto';
import { MAX_IMPORT_ROWS, readUploadedCsv } from './import-file.util';
import { toLiftRecordResponse } from './mappers';
import {
  assertMacrocycleWritable,
  checkMacrocycleId,
  lockForImport,
} from './macrocycle-history.util';
import { liftNamesFor, effectiveSlotMapFor } from './effective-slot-map.util';
import { writeFileNumberRows } from './import-handlers';
import { RlsTxTimeout } from '../adapters/prisma/rls-context';
import { IMPORT_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';

/** Whether two sets carry the same modifications, in any order. */
function sameModifications(a: LiftRecord, b: LiftRecord): boolean {
  const ids = (r: LiftRecord) => [...(r.modifications ?? [])].sort().join();
  return ids(a) === ids(b);
}

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
    const repos = await this.factory.forUser(user);
    const { liftRecord, macrocycleDashboard } = repos;
    const dashboard = await macrocycleDashboard.getMacrocycleDashboard(program);
    const records = await liftRecord.getLiftRecords(program, dashboard.macrocycleNum);
    const names = await modificationNamesFor(repos, records);
    return records.map((r) => toLiftRecordResponse(r, names));
  }

  @Post('lift-records')
  @HttpCode(HttpStatus.CREATED)
  @AllowsNonCycleProgram()
  async createLiftRecord(
    @Param('program') program: string,
    @Body() body: CreateLiftRecordDto,
    @CurrentUser() user: AuthUser,
    @Headers(MACROCYCLE_ID_HEADER) macrocycleId?: string,
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
    const nonCycle = program === NON_CYCLE_PROGRAM;
    // The DTO allows a non-cycle workout's open-ended numbers (#1184); every program keeps 1000.
    if (!nonCycle && body.workoutNum > MAX_WORKOUT_NUM) {
      throw new BadRequestException(`workoutNum must not be greater than ${MAX_WORKOUT_NUM}`);
    }

    const repos = await this.factory.forUser(user);
    const { liftRecord, macrocycleScheduledWorkout } = repos;
    const idRow = await checkMacrocycleId(repos, program, body.macrocycleNum, macrocycleId, 'POST lift-records');
    assertMacrocycleWritable(program, idRow);
    if (nonCycle) await assertNonCycleSet(repos, body.workoutNum, body.date);

    const modificationNames = await assertSetModifications(repos, body.lift, body.modifications ?? []);

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
      const scheduled = await macrocycleScheduledWorkout.getScheduledWorkouts(program, body.macrocycleNum);
      const match = scheduled.find((s) => s.workoutNum === body.workoutNum);
      // `scheduledDate` is `@db.Date` (no time component) so it's already
      // UTC-midnight-equivalent, but normalize it too for defense in depth —
      // the bare `new Date()` fallback is the one source with no upstream
      // guarantee at all.
      effectiveDate = toUTCMidnight(match?.scheduledDate ?? new Date());
    }

    const record: LiftRecord = {
      program,
      macrocycleNum: body.macrocycleNum,
      workoutNum: body.workoutNum,
      date: effectiveDate,
      lift: body.lift,
      ...withOccurrence(body.occurrence),
      setNum: body.setNum,
      weight: body.weight,
      reps: body.reps,
      notes: body.notes ?? '',
      ...withModifications(body.modifications),
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
      // Matched on the natural key itself, so a field added to the key reaches this
      // lookup without a second edit (#1027).
      const key = liftRecordNaturalKey(record);
      const existing = (await liftRecord.getLiftRecords(program, record.macrocycleNum)).find(
        (r) => liftRecordNaturalKey(r) === key,
      );
      if (
        existing &&
        existing.weight === record.weight &&
        existing.reps === record.reps &&
        existing.notes === record.notes &&
        sameModifications(existing, record)
      ) {
        return toLiftRecordResponse(existing, modificationNames);
      }
      const existingId = existing ? buildLiftRecordId(program, existing) : null;
      throw new ConflictException(
        `A lift record already exists for ${record.lift}` +
          (record.occurrence ? ` (occurrence ${record.occurrence})` : '') +
          `, macrocycle ${record.macrocycleNum}, ` +
          `workout ${record.workoutNum}, set ${record.setNum} on ${record.date.toISOString().slice(0, 10)}` +
          (existingId
            ? `. Update it with PATCH /programs/${program}/lift-records/${existingId} instead.`
            : '.'),
      );
    }
    return toLiftRecordResponse(record, modificationNames);
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
   * DEFAULT_SLOT_MAP, the calling user's own custom lifts and the built-in catalog,
   * by exact name (effectiveSlotMapFor / buildImportSlotMap — issues #911, #1116).
   * DEFAULT_SLOT_MAP wins on a name collision, so a custom lift can never shadow a
   * canonical abbreviation. Programs do not restrict which lifts may be imported — all
   * lifts present in the effective slot map are accepted for any program.
   * (Preloaded template programs become custom programs when edited; custom
   * programs have no lift restrictions.)
   *
   * Rows whose natural key (macrocycleNum, workoutNum, date, lift, setNum) already exist
   * for the program — or that repeat an earlier row's key within this same file, or
   * repeat an earlier row under another spelling of the lift (#1191) —
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
  // effectiveSlotMapFor query added by #911) inside the same per-request RLS transaction.
  // Widens how long a pooled connection can be pinned by a slow client upload too, not
  // just DB work — parity with an already-shipped property on ImportController's own
  // import path, not a new exposure class; structural fix tracked in #925.
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

    const { valid, errors } = validateLiftImport(parsed, await effectiveSlotMapFor(repos));
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Validation failed', errors });
    }

    // After validation, so an invalid file gets its errors without waiting for the lock, and a
    // valid one doesn't hold page writes off while it's checked. Before the reads it guards.
    await lockForImport(repos);

    // Stamp each record with the route program before persisting. The shared writer pairs each
    // with its 1-based CSV row number (shared with the Smart Import wizard's liftRecordsHandler —
    // issues #891/#896) so a skip can be reported against the original file position. `written`
    // comes directly from the database's createMany count.
    const { classified, created: written } = await writeFileNumberRows(
      repos,
      program,
      valid.map((r) => withImportProgram(r, program)),
    );

    const liftNames = await liftNamesFor(repos);
    const skipped = buildSkippedDetail(classified, (r) => liftRecordLabel(r, liftNames));

    return { written, skipped };
  }

  @Patch('lift-records/:id')
  @AllowsNonCycleProgram()
  async updateLiftRecord(
    @Param('program') program: string,
    @Param('id') id: string,
    @Body() body: UpdateLiftRecordDto,
    @CurrentUser() user: AuthUser,
    @Headers(MACROCYCLE_ID_HEADER) macrocycleId?: string,
  ): Promise<LiftRecordResponse> {
    const repos = await this.factory.forUser(user);
    const { liftRecord } = repos;
    const notFound = () => new NotFoundException(`Lift record '${id}' not found for program '${program}'`);
    const key = parseLiftRecordId(program, id);
    if (!key) throw notFound();
    const idRow = await checkMacrocycleId(repos, program, key.macrocycleNum, macrocycleId, 'PATCH lift-records/:id');
    assertMacrocycleWritable(program, idRow);

    let checkedNames: ReadonlyMap<string, string> | undefined;
    if (body.modifications !== undefined) {
      // The rule needs the set's lift and what it already has, so this reads the record first.
      const stored = (await liftRecord.getLiftRecords(program, key.macrocycleNum)).find(
        (r) => buildLiftRecordId(program, r) === id,
      );
      if (!stored) throw notFound();
      checkedNames = await assertSetModifications(repos, stored.lift, body.modifications, stored.modifications);
    }

    const updated = await liftRecord.updateLiftRecord(program, id, body);
    if (!updated) throw notFound();
    return toLiftRecordResponse(updated, checkedNames ?? (await modificationNamesFor(repos, [updated])));
  }
}
