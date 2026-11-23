import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
  BadGatewayException,
} from '@nestjs/common';
import {
  DEFAULT_CAFFEINE_CUTOFF,
  SupplementChangeBody,
  applyChange,
  isSameData,
  isWorkoutSlot,
  parseGoogleSheetUrl,
  itemFromCatalog,
  searchSupplements,
  stackAsOf,
  supplementByKey,
  toCatalogEntry,
  validateStack,
} from '@lifting-logbook/core';
import {
  SUPPLEMENT_TEXT_MAX,
  SupplementAsOfResponse,
  SupplementAiSuggestionResponse,
  SupplementCatalogEntry,
  SupplementLabelLookupResponse,
  SupplementChange,
  SupplementCreatedResponse,
  SupplementDose,
  SupplementItem,
  SupplementItemDetails,
  SupplementSheetResponse,
  SupplementSheetTab,
  SupplementStackResponse,
} from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { SupplementNotRemovedError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { ISupplementRepository, SupplementState } from '../ports/ISupplementRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { SupplementSheetMirrorTrigger } from '../supplement-sheet-mirror/supplement-sheet-mirror.trigger';
import { GoogleSheetFetchError, downloadGoogleSheetXlsx } from '../adapters/google-sheets/google-sheet-export.client';
import { MAX_TABLE_COLUMNS, WorkbookTable, XlsxReadError, xlsxToTables } from '../adapters/google-sheets/xlsx-to-tables';
import { SupplementSuggestionsService } from '../supplement-suggestions/supplement-suggestions.service';
import { parseIsoDateParam, parseWriteToday } from '../iso-date-param';
import {
  CreateMixDto,
  CreateSupplementItemDto,
  ImportSupplementsDto,
  MoveDosesDto,
  RemoveItemsDto,
  SetStatusDto,
  SupplementSettingsDto,
  SupplementAiSuggestionDto,
  SupplementSheetDto,
  UpdateSupplementItemDto,
} from './supplements.dto';

const DETAIL_KEYS = ['name', 'keyCompound', 'timing', 'shortNote', 'longNote', 'links', 'ingredients', 'category', 'typicalRange'] as const;

/** `GET /changes` page size: the default, and the most one request may ask for. */
const CHANGES_PAGE = 200;
const CHANGES_PAGE_MAX = 1000;
/** The largest `seq` there can be: `supplement_change.seq` is a Postgres `integer`. */
const SEQ_MAX = 2_147_483_647;
/** The most rows a supplement import reads from one tab; `ImportSupplementsDto` takes as many. */
const MAX_IMPORT_ROWS = 500;

/** The link if it's a web link, else '': only http(s) targets go back to the client. */
const webLink = (href: string) => (/^https?:\/\//i.test(href.trim()) ? href : '');

/**
 * What a write does: reads the state as loaded, checks the request against it, and returns the
 * changes that carry it out. `write` applies them with `applyChange`, so a plan never changes
 * the state itself, except that a restore puts the item it restores in `state.removed`.
 */
type Plan<B> = (state: SupplementState, body: B, repo: ISupplementRepository) => Promise<SupplementChangeBody[]> | SupplementChangeBody[];

function view(state: SupplementState): SupplementStackResponse {
  return { items: state.items, dayTypes: state.dayTypes, caffeineCutoff: state.caffeineCutoff ?? DEFAULT_CAFFEINE_CUTOFF };
}

/** The item with this id in the stack, and where it is, or a 404. */
function find(state: SupplementState, id: string): { index: number; item: SupplementItem } {
  const index = state.items.findIndex((item) => item.id === id);
  const item = state.items[index];
  if (!item) throw new NotFoundException(`No supplement item ${id}`);
  return { index, item };
}

/**
 * The parts folded into a mix in the stack, each named `Mix (Part)` so a 400 names the mix the
 * user can see. Parts of a removed mix are left out, like removed items: they're reconciled with
 * the day types when the mix is restored, which brings them back into this list.
 */
function liveParts(state: SupplementState): SupplementItem[] {
  return state.folded.flatMap(({ item, mixId }) => {
    const mix = state.items.find((i) => i.id === mixId);
    return mix ? [{ ...item, name: `${mix.name} (${item.name})` }] : [];
  });
}

/**
 * What restoring `item` changes, given the day types there are now (ADR-046). A day type removed
 * since is taken off its doses. A workout-slot dose left with none is dropped, and the item comes
 * back pending, so a restore never fails and never strands an item: one `moved` change logs the
 * doses as they are now, and `moved_to_pending` the status.
 */
function reconcileRestored(item: SupplementItem, known: ReadonlySet<string>): SupplementChangeBody[] {
  const filtered = item.doses.map((d) => ({ ...d, dayTypes: d.dayTypes.filter((t) => known.has(t)) }));
  const doses = filtered.filter((d) => !(isWorkoutSlot(d.slot) && d.dayTypes.length === 0));
  const changes: SupplementChangeBody[] = [];
  if (!isSameData(doses, item.doses)) changes.push({ type: 'moved', itemId: item.id, doses });
  if (doses.length < filtered.length && item.status !== 'pending') changes.push({ type: 'moved_to_pending', itemId: item.id });
  return changes;
}

/** `value` as a whole number from `min` to `max`, `fallback` when absent, or a 400. */
function intParam(name: string, value: string | undefined, min: number, max: number, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < min || n > max) throw new BadRequestException(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/**
 * The supplement stack, its day types and its change log (#1374). Every write takes the user's
 * write lock, reads the stored state, applies one plan's changes to it with `applyChange`,
 * validates the result, and saves it with those changes in one transaction (ADR-046). `today`
 * (`YYYY-MM-DD`, the lifter's local date) is required and dates the changes; it can't be earlier
 * than the last change's date, so the log's dates and its `seq` agree on the order, or more than
 * a day past the server's UTC date, so one wrong date can't block every later write.
 */
@Controller('supplements')
export class SupplementsController {
  private readonly logger = new Logger(SupplementsController.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly mirror: SupplementSheetMirrorTrigger,
    private readonly suggestions: SupplementSuggestionsService,
  ) {}

  /** The stack and its day types. */
  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<SupplementStackResponse> {
    return view(await (await this.repo(user)).load());
  }

  /**
   * A page of the change log, oldest first: the latest `limit` changes (200 by default, at most
   * 1000) before `beforeSeq`, or before the end. The next page back is `beforeSeq` = the first
   * change's `seq`.
   */
  @Get('changes')
  async changes(
    @Query('beforeSeq') beforeSeq: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementChange[]> {
    const before = intParam('beforeSeq', beforeSeq, 1, SEQ_MAX);
    const take = intParam('limit', limit, 1, CHANGES_PAGE_MAX, CHANGES_PAGE) ?? CHANGES_PAGE;
    return (await this.repo(user)).changes({ ...(before === undefined ? {} : { beforeSeq: before }), limit: take });
  }

  /**
   * The stack at the end of `date`, replayed from the change log, with the date the log starts
   * and any changes replay skipped, which are also logged as a warning.
   */
  @Get('as-of/:date')
  async asOf(@Param('date') date: string, @CurrentUser() user: AuthUser): Promise<SupplementAsOfResponse> {
    parseIsoDateParam('date', date);
    const repo = await this.repo(user);
    const replay = stackAsOf(await repo.changesThrough(date), date);
    const anomalies = replay.anomalies.map(({ change, itemId, reason }) => ({ seq: change.seq, type: change.type, itemId, reason }));
    if (anomalies.length > 0) {
      // Ids, types and reasons only: no item names or notes.
      this.logger.warn({ date, count: anomalies.length, anomalies }, 'Supplement change log replay skipped changes (#1374)');
    }
    return { items: replay.stack, dayTypes: replay.dayTypes, firstChangeDate: await repo.firstChangeDate(), anomalies };
  }

  /**
   * Catalog entries whose name or an alias contains `q`, for autofill. The catalog is the same for
   * every user (#1375). Fastify reads a repeated `q` as an array, which is a 400.
   */
  @Get('catalog')
  catalog(@Query('q') q: string | string[] | undefined): SupplementCatalogEntry[] {
    if (Array.isArray(q)) throw new BadRequestException('q must be given once');
    return searchSupplements(q ?? '').map(toCatalogEntry);
  }

  /** Tier 2 (#1381): product labels from the NIH label database, for a name the catalog doesn't have. */
  @Get('label-lookup')
  labelLookup(@Query('q') q: string | string[] | undefined): Promise<SupplementLabelLookupResponse> {
    if (Array.isArray(q)) throw new BadRequestException('q must be given once');
    return this.suggestions.labelLookup(q ?? '');
  }

  /** Tier 3 (#1381): an AI suggestion from the typed name alone. The client saves it unverified. */
  @Post('ai-suggestion')
  @HttpCode(HttpStatus.OK)
  aiSuggestion(@CurrentUser() user: AuthUser, @Body() body: SupplementAiSuggestionDto): Promise<SupplementAiSuggestionResponse> {
    return this.suggestions.aiSuggest({ userId: user.id, name: body.name });
  }

  /**
   * Creates an item. With `catalogKey`, a field left out takes the catalog entry's value (one sent
   * blank is kept), and
   * the entry's reference content is copied onto the item (`itemFromCatalog`); an unknown key is a 400.
   */
  @Post('items')
  async create(
    @Body() dto: CreateSupplementItemDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementCreatedResponse> {
    const id = randomUUID();
    const state = await this.write(user, today, dto, (_state, body) => {
      const entry = body.catalogKey === undefined ? undefined : supplementByKey(body.catalogKey);
      if (body.catalogKey !== undefined && !entry) throw new BadRequestException(`No catalog entry ${body.catalogKey}`);
      const fields = entry
        ? itemFromCatalog(entry, body)
        : {
            name: body.name,
            keyCompound: body.keyCompound ?? '',
            timing: body.timing ?? '',
            shortNote: body.shortNote ?? '',
            longNote: body.longNote ?? '',
            links: body.links ?? [],
            category: body.category ?? '',
            typicalRange: body.typicalRange ?? '',
            ingredients: body.ingredients ?? [],
          };
      const item: SupplementItem = {
        id,
        ...fields,
        status: body.status ?? 'active',
        unverified: body.unverified ?? false,
        doses: body.doses ?? [],
      };
      return [{ type: 'added', item }];
    });
    return { ...view(state), id };
  }

  /**
   * Reads a shared Google Sheet for the supplement import (#1379): every tab as rows plus each
   * cell's hyperlink. Reuses ADR-040's client; counts are logged, never cell contents or the URL.
   * `@SkipRlsTransaction()` so no connection is held during the Google download.
   */
  @Post('import/google-sheet')
  @HttpCode(HttpStatus.OK)
  @SkipRlsTransaction()
  async fetchSheet(@Body() dto: SupplementSheetDto): Promise<SupplementSheetResponse> {
    const parsed = parseGoogleSheetUrl(dto.url);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    const started = Date.now();
    let buffer: Buffer;
    try {
      buffer = await downloadGoogleSheetXlsx(parsed.spreadsheetId);
    } catch (err) {
      if (!(err instanceof GoogleSheetFetchError)) throw err;
      this.logger.warn({ code: err.code, durationMs: Date.now() - started }, 'Supplement sheet fetch failed (#1379)');
      if (err.code === 'not-shared') throw new UnprocessableEntityException(err.message);
      if (err.code === 'not-found') throw new NotFoundException(err.message);
      if (err.code === 'too-large') throw new PayloadTooLargeException(err.message);
      throw new BadGatewayException(err.message);
    }
    let tables: WorkbookTable[];
    try {
      // +1 for the header row.
      tables = xlsxToTables(buffer, { maxRows: MAX_IMPORT_ROWS + 1 });
    } catch (err) {
      if (!(err instanceof XlsxReadError)) throw err;
      this.logger.warn({ code: err.code, bytes: buffer.length }, 'Supplement sheet workbook could not be read (#1379)');
      if (err.code === 'too-large') throw new PayloadTooLargeException(err.message);
      throw new BadGatewayException('Google Sheets returned a workbook that could not be read.');
    }
    const tabs = tables
      .filter((t) => t.rows.length > 0)
      .map(({ name, rows, links, rowNumbers, overflow }): SupplementSheetTab => {
        // Not sent: the lifter can't import any of it, and the reason says why.
        if (overflow === 'rows') return { name, rows: [], links: [], skipReason: `More than ${MAX_IMPORT_ROWS} rows, the per-import limit.` };
        if (overflow === 'columns') return { name, rows: [], links: [], skipReason: `Has data past column ${MAX_TABLE_COLUMNS}, too wide to import.` };
        return {
          name,
          rows,
          // Web links only: a `mailto:` or `javascript:` target is never passed on.
          links: rows.map((row, r) => row.map((_, c) => webLink(links?.[r]?.[c] ?? ''))),
          ...(rowNumbers ? { rowNumbers } : {}),
          skipReason: null,
        };
      });
    // Counts only: tab names, cell contents and the link are the lifter's data.
    this.logger.log(
      {
        bytes: buffer.length,
        tabs: tabs.length,
        skippedTabs: tabs.filter((t) => t.skipReason !== null).length,
        rows: tabs.reduce((n, t) => n + t.rows.length, 0),
        durationMs: Date.now() - started,
      },
      'Supplement sheet read (#1379)',
    );
    return { tabs };
  }

  /**
   * Imports the reviewed rows in one write: one `added` change per item, noted
   * "Imported from <source>", so History starts at the import and the import is all or nothing
   * (Fowler, Event Sourcing, https://martinfowler.com/eaaDev/EventSourcing.html). A row with a
   * catalog key takes the entry's reference content (`itemFromCatalog`). A workout-slot dose
   * takes every day type there is, and is dropped when there are none: the timing text stays, with
   * the dropped dose's amount in front of it unless a kept dose has the same amount, so the amount
   * isn't lost. Counts are logged, never contents; `skipped` is the client's count, for the log.
   */
  @Post('import')
  async importItems(
    @Body() dto: ImportSupplementsDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, dto, (state, body) => {
      const allDayTypes = state.dayTypes.map((d) => d.id);
      return body.rows.map((row): SupplementChangeBody => {
        const entry = row.catalogKey === undefined ? undefined : supplementByKey(row.catalogKey);
        if (row.catalogKey !== undefined && !entry) throw new BadRequestException(`No catalog entry ${row.catalogKey}`);
        const needsDayType = (d: SupplementDose) => isWorkoutSlot(d.slot) && d.dayTypes.length === 0;
        const dropped = allDayTypes.length > 0 ? [] : row.doses.filter(needsDayType);
        const doses = row.doses
          .filter((d) => !dropped.includes(d))
          .map((d) => (needsDayType(d) ? { ...d, dayTypes: allDayTypes } : d));
        const lost = [...new Set(dropped.map((d) => d.amount))].filter((a) => a !== '' && !doses.some((d) => d.amount === a));
        const timing = [...lost, row.timing].filter((t) => t !== '').join(' ').slice(0, SUPPLEMENT_TEXT_MAX.name);
        const typed = {
          name: row.name,
          ...(timing === '' ? {} : { timing }),
          shortNote: row.shortNote,
          longNote: row.longNote,
          links: row.links,
        };
        const fields = entry
          ? itemFromCatalog(entry, typed)
          : { keyCompound: '', category: '', typicalRange: '', ingredients: [], timing: '', ...typed };
        const item: SupplementItem = { id: randomUUID(), ...fields, status: row.status, unverified: false, doses };
        return { type: 'added', item, note: `Imported from ${body.source}` };
      });
    });
    this.logger.log(
      {
        imported: dto.rows.length,
        pending: dto.rows.filter((r) => r.status === 'pending').length,
        skipped: dto.skipped ?? 0,
      },
      'Supplements imported (#1379)',
    );
    return view(state);
  }

  /**
   * Edits details, replaces doses, starts or pends, or confirms an item: one change for each
   * kind, logging only the fields that differ from what's stored.
   */
  @Patch('items/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSupplementItemDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, dto, (state, body) => {
      const { item } = find(state, id);
      const changes: SupplementChangeBody[] = [];
      const details: Partial<SupplementItemDetails> = {};
      for (const key of DETAIL_KEYS) {
        const value = body[key];
        if (value !== undefined && !isSameData(value, item[key])) Object.assign(details, { [key]: value });
      }
      if (Object.keys(details).length > 0) changes.push({ type: 'edited', itemId: id, changes: details });
      if (body.doses !== undefined && !isSameData(body.doses, item.doses)) {
        changes.push({ type: 'moved', itemId: id, doses: body.doses });
      }
      if (body.status !== undefined && body.status !== item.status) {
        changes.push({ type: body.status === 'active' ? 'started' : 'moved_to_pending', itemId: id });
      }
      if (body.unverified === false && item.unverified) changes.push({ type: 'confirmed', itemId: id });
      return changes;
    });
    return view(state);
  }

  /** Removes an item; its `removed` change keeps the whole item so it can be restored. */
  @Delete('items/:id')
  async remove(
    @Param('id') id: string,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, undefined, (state) => [{ type: 'removed', item: find(state, id).item }]);
    return view(state);
  }

  /**
   * Removes the listed items in one write, one `removed` change each, so they all go or none do
   * (#1414). An unknown id is a 404 and removes nothing.
   */
  @Post('items/remove')
  async removeMany(
    @Body() dto: RemoveItemsDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, dto, (state, body) =>
      [...new Set(body.itemIds)].map((id): SupplementChangeBody => ({ type: 'removed', item: find(state, id).item })),
    );
    return view(state);
  }

  /**
   * Brings back a removed item as it was removed, to the end of the stack, with a mix's parts.
   * A day type removed since is taken off its doses and its parts', as a `moved` change for each
   * that changed; an item or part whose workout-slot dose is left with none loses that dose and
   * comes back pending (`reconcileRestored`). A 409 when the item is in the stack, or is part of
   * a mix, which the 409 names.
   */
  @Post('items/:id/restore')
  async restore(
    @Param('id') id: string,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, undefined, async (state, _body, repo) => {
      if (state.items.some((i) => i.id === id)) throw new SupplementNotRemovedError(id);
      const folded = state.folded.find((f) => f.item.id === id);
      if (folded) {
        const mix = state.items.find((i) => i.id === folded.mixId) ?? (await repo.lastRemoved(folded.mixId));
        const removed = !state.items.some((i) => i.id === folded.mixId);
        throw new SupplementNotRemovedError(id, { id: folded.mixId, name: mix?.name ?? folded.mixId, removed });
      }
      const item = await repo.lastRemoved(id);
      if (!item) throw new NotFoundException(`No removed supplement item ${id}`);
      state.removed = [item];
      const known = new Set(state.dayTypes.map((d) => d.id));
      const parts = state.folded.filter((f) => f.mixId === id).map((f) => f.item);
      return [{ type: 'restored', itemId: id }, ...[item, ...parts].flatMap((i) => reconcileRestored(i, known))];
    });
    return view(state);
  }

  /**
   * Replaces the day types and sets the caffeine cutoff. A day type left out is taken off every
   * dose in the stack, including those of the parts of a mix in it, as a `moved` change; a
   * workout-slot dose left with none is a 400, naming the mix for a part of one. A removed item
   * and the parts of a removed mix are left as they are, and reconciled when restored.
   */
  @Put('settings')
  async settings(
    @Body() dto: SupplementSettingsDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, dto, (state, body) => {
      const changes: SupplementChangeBody[] = [];
      if (body.caffeineCutoff !== undefined && body.caffeineCutoff !== state.caffeineCutoff) {
        changes.push({ type: 'caffeine_cutoff_set', caffeineCutoff: body.caffeineCutoff });
      }
      if (body.dayTypes === undefined) return changes;
      const known = new Set(body.dayTypes.map((d) => d.id));
      if (known.size !== body.dayTypes.length) throw new BadRequestException('Day type ids must be unique');
      if (!isSameData(body.dayTypes, state.dayTypes)) changes.push({ type: 'day_types_set', dayTypes: body.dayTypes });
      const partsInStack = state.folded.filter((f) => state.items.some((i) => i.id === f.mixId)).map((f) => f.item);
      for (const item of [...state.items, ...partsInStack]) {
        const doses = item.doses.map((d) => ({ ...d, dayTypes: d.dayTypes.filter((t) => known.has(t)) }));
        if (!isSameData(doses, item.doses)) changes.push({ type: 'moved', itemId: item.id, doses });
      }
      return changes;
    });
    return view(state);
  }

  /**
   * Moves doses to another slot, optionally onto other day types: the listed items' doses in
   * `from`, or exactly the doses `doses` names. A named dose that isn't where the client saw it
   * (the stack changed since) is a 400, so a stale page never moves a different dose.
   */
  @Post('doses/move')
  async moveDoses(
    @Body() dto: MoveDosesDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, dto, (state, body) => {
      const ids = new Set(body.itemIds);
      const stray = body.doses?.find((r) => !ids.has(r.itemId));
      if (stray) throw new BadRequestException(`doses names ${stray.itemId}, which isn't in itemIds`);
      const changes: SupplementChangeBody[] = [];
      for (const id of ids) {
        const { item } = find(state, id);
        const named = body.doses?.filter((r) => r.itemId === id);
        for (const r of named ?? []) {
          if (item.doses[r.index]?.slot !== r.slot) {
            throw new BadRequestException(`"${item.name}" has no ${r.slot} dose at position ${r.index}; reload and try again`);
          }
        }
        const moves = (d: SupplementItem['doses'][number], i: number) => (named ? named.some((r) => r.index === i) : d.slot === body.from);
        const doses = item.doses.map((d, i) =>
          moves(d, i) ? { ...d, slot: body.to, dayTypes: body.dayTypes ?? d.dayTypes } : d,
        );
        if (!isSameData(doses, item.doses)) changes.push({ type: 'moved', itemId: id, doses });
      }
      return changes;
    });
    return view(state);
  }

  /** Marks the listed items active or pending. */
  @Post('items/status')
  async setStatus(
    @Body() dto: SetStatusDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, dto, (state, body) => {
      const changes: SupplementChangeBody[] = [];
      for (const id of new Set(body.itemIds)) {
        if (find(state, id).item.status === body.status) continue;
        changes.push({ type: body.status === 'active' ? 'started' : 'moved_to_pending', itemId: id });
      }
      return changes;
    });
    return view(state);
  }

  /**
   * Combines items into a new mix in the first one's place. The parts leave the stack but are
   * kept, so splitting the mix brings them back. The mix takes the first part's doses.
   */
  @Post('mixes')
  async createMix(
    @Body() dto: CreateMixDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementCreatedResponse> {
    const id = randomUUID();
    const state = await this.write(user, today, dto, (state, body) => {
      const partIds = [...new Set(body.itemIds)];
      const [firstId, ...otherIds] = partIds;
      if (firstId === undefined || otherIds.length === 0) throw new BadRequestException('A mix needs at least two different items');
      const first = find(state, firstId).item;
      const parts = [first, ...otherIds.map((partId) => find(state, partId).item)];
      const nested = parts.find((p) => p.parts !== undefined);
      if (nested) throw new BadRequestException(`${nested.name} is already a mix; split it first`);
      const mix: SupplementItem = {
        id,
        name: body.name,
        keyCompound: '',
        timing: first.timing,
        shortNote: '',
        longNote: '',
        status: first.status,
        unverified: parts.some((p) => p.unverified),
        links: [],
        category: '',
        typicalRange: '',
        ingredients: [],
        parts: parts.map((p) => ({ itemId: p.id, name: p.name, ingredients: p.ingredients })),
        doses: first.doses,
      };
      return [{ type: 'mix_created', mix, partIds }];
    });
    return { ...view(state), id };
  }

  /** Splits a mix back into its parts, in its place; the mix goes. */
  @Post('mixes/:id/split')
  async splitMix(
    @Param('id') id: string,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplementStackResponse> {
    const state = await this.write(user, today, undefined, (state) => {
      const { item } = find(state, id);
      if (item.parts === undefined) throw new BadRequestException(`${item.name} is not a mix`);
      return [{ type: 'mix_split', mixId: id }];
    });
    return view(state);
  }

  private async repo(user: AuthUser): Promise<ISupplementRepository> {
    return (await this.factory.forUser(user)).supplement;
  }

  /**
   * Runs `plan` under the user's write lock and saves its changes, dated `today`. The body is
   * copied to plain data first, so it stores and compares like any other value.
   */
  private async write<B>(user: AuthUser, todayParam: string | undefined, dto: B, plan: Plan<B>): Promise<SupplementState> {
    const today = parseWriteToday(todayParam);
    const body = structuredClone(dto);
    const repos = await this.factory.forUser(user);
    const repo = repos.supplement;
    let logged = false;
    const saved = await repo.write(async (state) => {
      if (state.lastChangeDate !== null && today < state.lastChangeDate) {
        throw new BadRequestException(
          `today (${today}) is before the stack's last change (${state.lastChangeDate}); changes can't be dated earlier`,
        );
      }
      const changes = await plan(state, body, repo);
      for (const change of changes) {
        const anomalies = applyChange(state, change);
        // The plan checked the request against the state, so this is a bug, not a bad request.
        if (anomalies.length > 0) {
          throw new Error(`Supplement ${change.type} change didn't apply: ${anomalies.map((a) => `${a.itemId} ${a.reason}`).join(', ')}`);
        }
      }
      const errors = validateStack([...state.items, ...liveParts(state)], state.dayTypes);
      if (errors.length > 0) throw new BadRequestException(errors);
      logged = changes.length > 0;
      return changes.map((change) => ({ ...change, date: today }));
    });
    // Reads the sheet link in this write's transaction; a linked sheet's mirror is enqueued once it
    // commits (ADR-047, decision 16).
    if (logged) await this.mirror.afterWrite(user, repos.googleSheetLink);
    return saved;
  }
}
