import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { DEFAULT_CAFFEINE_CUTOFF, stackAsOf, toIsoDate, validateStack } from '@lifting-logbook/core';
import {
  SupplementChange,
  SupplementItem,
  SupplementItemDetails,
  SupplementStackResponse,
} from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { SupplementWriteConflictError } from '../ports/errors';
import { IRepositoryFactory } from '../ports/factory';
import { NewSupplementChange, SupplementState } from '../ports/ISupplementRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { parseIsoDateParam } from '../focus/focus.util';
import {
  CreateMixDto,
  CreateSupplementItemDto,
  MoveDosesDto,
  SetStatusDto,
  SupplementSettingsDto,
  UpdateSupplementItemDto,
} from './supplements.dto';

const DETAIL_KEYS = ['name', 'keyCompound', 'timing', 'shortNote', 'longNote', 'links', 'ingredients'] as const;

/** A change's mutation of the stack, returning the changes it appends to the log. */
type Plan = (state: SupplementState, date: string) => NewSupplementChange[];

function view(state: SupplementState): SupplementStackResponse {
  return { items: state.items, dayTypes: state.dayTypes, caffeineCutoff: state.caffeineCutoff ?? DEFAULT_CAFFEINE_CUTOFF };
}

function indexOf(state: SupplementState, id: string): number {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) throw new NotFoundException(`No supplement item ${id}`);
  return index;
}

/** A DTO as plain data, so it stores and compares like any other value. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The supplement stack, its day types and its change log (#1374). Every write reads the stored
 * state, applies one plan to it, validates the result, and saves it with the plan's changes in
 * one transaction (ADR-046). `today` (`YYYY-MM-DD`, the lifter's local date) dates the changes;
 * without it they take today's UTC date.
 */
@Controller('supplements')
export class SupplementsController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  /** The stack and its day types. */
  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<SupplementStackResponse> {
    return view(await (await this.factory.forUser(user)).supplement.load());
  }

  /** Every change, oldest first. */
  @Get('changes')
  async changes(@CurrentUser() user: AuthUser): Promise<SupplementChange[]> {
    return (await this.factory.forUser(user)).supplement.changes();
  }

  /** The stack at the end of `date`, replayed from the change log. */
  @Get('as-of/:date')
  async asOf(@Param('date') date: string, @CurrentUser() user: AuthUser): Promise<{ items: SupplementItem[] }> {
    parseIsoDateParam('date', date);
    const log = await (await this.factory.forUser(user)).supplement.changes();
    return { items: stackAsOf(log, date).stack };
  }

  @Post('items')
  async create(@Body() dto: CreateSupplementItemDto, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    return this.write(user, today, (state, date) => {
      const body = plain(dto);
      const item: SupplementItem = {
        id: randomUUID(),
        name: body.name,
        keyCompound: body.keyCompound ?? '',
        timing: body.timing ?? '',
        shortNote: body.shortNote ?? '',
        longNote: body.longNote ?? '',
        status: body.status ?? 'active',
        unverified: body.unverified ?? false,
        links: body.links ?? [],
        ingredients: body.ingredients ?? [],
        doses: body.doses ?? [],
      };
      state.items.push(item);
      return [{ type: 'added', date, item }];
    });
  }

  /** Edits details, replaces doses, starts or pends, or confirms an item; one change for each. */
  @Patch('items/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSupplementItemDto,
    @Query('today') today: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.write(user, today, (state, date) => {
      const body = plain(dto);
      const index = indexOf(state, id);
      const current = state.items[index] as SupplementItem;
      const changes: NewSupplementChange[] = [];
      const details: Partial<SupplementItemDetails> = {};
      for (const key of DETAIL_KEYS) {
        if (body[key] !== undefined) Object.assign(details, { [key]: body[key] });
      }
      if (Object.keys(details).length > 0) changes.push({ type: 'edited', date, itemId: id, changes: details });
      if (body.doses !== undefined) changes.push({ type: 'moved', date, itemId: id, doses: body.doses });
      if (body.status !== undefined && body.status !== current.status) {
        changes.push({ type: body.status === 'active' ? 'started' : 'moved_to_pending', date, itemId: id });
      }
      if (body.unverified === false && current.unverified) changes.push({ type: 'confirmed', date, itemId: id });
      state.items[index] = {
        ...current,
        ...details,
        ...(body.doses !== undefined ? { doses: body.doses } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.unverified === false ? { unverified: false } : {}),
      };
      return changes;
    });
  }

  /** Removes an item; its `removed` change keeps the whole item so it can be restored. */
  @Delete('items/:id')
  async remove(@Param('id') id: string, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    return this.write(user, today, (state, date) => {
      const [item] = state.items.splice(indexOf(state, id), 1) as [SupplementItem];
      return [{ type: 'removed', date, item }];
    });
  }

  /** Brings back a removed item as it was removed. A 409 when it's already in the stack. */
  @Post('items/:id/restore')
  async restore(@Param('id') id: string, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    const log = await (await this.factory.forUser(user)).supplement.changes();
    return this.write(user, today, (state, date) => {
      if (state.items.some((i) => i.id === id) || state.folded.some((f) => f.item.id === id)) {
        throw new ConflictException(`Supplement item ${id} is not removed`);
      }
      const removed = log.filter((c) => c.type === 'removed' && c.item.id === id).pop();
      if (removed?.type !== 'removed') throw new NotFoundException(`No removed supplement item ${id}`);
      state.items.push(removed.item);
      return [{ type: 'restored', date, itemId: id }];
    });
  }

  /**
   * Replaces the day types and sets the caffeine cutoff. A day type left out is taken off every
   * dose, as a `moved` change; a workout-slot dose left with none is a 400.
   */
  @Put('settings')
  async settings(@Body() dto: SupplementSettingsDto, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    return this.write(user, today, (state, date) => {
      const body = plain(dto);
      if (body.caffeineCutoff !== undefined) state.caffeineCutoff = body.caffeineCutoff;
      if (body.dayTypes === undefined) return [];
      const known = new Set(body.dayTypes.map((d) => d.id));
      if (known.size !== body.dayTypes.length) throw new BadRequestException('Day type ids must be unique');
      state.dayTypes = body.dayTypes;
      const changes: NewSupplementChange[] = [];
      state.items = state.items.map((item) => {
        const doses = item.doses.map((d) => ({ ...d, dayTypes: d.dayTypes.filter((id) => known.has(id)) }));
        if (doses.every((d, i) => d.dayTypes.length === item.doses[i]?.dayTypes.length)) return item;
        changes.push({ type: 'moved', date, itemId: item.id, doses });
        return { ...item, doses };
      });
      return changes;
    });
  }

  /** Moves the listed items' doses in one slot to another, optionally onto other day types. */
  @Post('doses/move')
  async moveDoses(@Body() dto: MoveDosesDto, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    return this.write(user, today, (state, date) => {
      const body = plain(dto);
      const changes: NewSupplementChange[] = [];
      for (const id of new Set(body.itemIds)) {
        const index = indexOf(state, id);
        const item = state.items[index] as SupplementItem;
        if (!item.doses.some((d) => d.slot === body.from)) continue;
        const doses = item.doses.map((d) =>
          d.slot === body.from ? { ...d, slot: body.to, dayTypes: body.dayTypes ?? d.dayTypes } : d,
        );
        state.items[index] = { ...item, doses };
        changes.push({ type: 'moved', date, itemId: id, doses });
      }
      return changes;
    });
  }

  /** Marks the listed items active or pending. */
  @Post('items/status')
  async setStatus(@Body() dto: SetStatusDto, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    return this.write(user, today, (state, date) => {
      const changes: NewSupplementChange[] = [];
      for (const id of new Set(dto.itemIds)) {
        const index = indexOf(state, id);
        const item = state.items[index] as SupplementItem;
        if (item.status === dto.status) continue;
        state.items[index] = { ...item, status: dto.status };
        changes.push({ type: dto.status === 'active' ? 'started' : 'moved_to_pending', date, itemId: id });
      }
      return changes;
    });
  }

  /**
   * Combines items into a new mix in the first one's place. The parts leave the stack but are
   * kept, so splitting the mix brings them back. The mix takes the first part's doses.
   */
  @Post('mixes')
  async createMix(@Body() dto: CreateMixDto, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    return this.write(user, today, (state, date) => {
      const partIds = [...new Set(dto.itemIds)];
      if (partIds.length < 2) throw new BadRequestException('A mix needs at least two different items');
      const parts = partIds.map((id) => state.items[indexOf(state, id)] as SupplementItem);
      const nested = parts.find((p) => p.parts !== undefined);
      if (nested) throw new BadRequestException(`${nested.name} is already a mix; split it first`);
      const [first] = parts as [SupplementItem];
      const mix: SupplementItem = {
        id: randomUUID(),
        name: dto.name,
        keyCompound: '',
        timing: first.timing,
        shortNote: '',
        longNote: '',
        status: first.status,
        unverified: parts.some((p) => p.unverified),
        links: [],
        ingredients: [],
        parts: parts.map((p) => ({ itemId: p.id, name: p.name, ingredients: p.ingredients })),
        doses: first.doses,
      };
      state.items.splice(indexOf(state, first.id), 0, mix);
      state.items = state.items.filter((i) => !partIds.includes(i.id));
      state.folded.push(...parts.map((item) => ({ item, mixId: mix.id })));
      return [{ type: 'mix_created', date, mix, partIds }];
    });
  }

  /**
   * Splits a mix back into its parts, in its place. The mix goes, unless it was an item others
   * were folded into, which goes back to being itself.
   */
  @Post('mixes/:id/split')
  async splitMix(@Param('id') id: string, @Query('today') today: string | undefined, @CurrentUser() user: AuthUser) {
    return this.write(user, today, (state, date) => {
      const index = indexOf(state, id);
      const mix = state.items[index] as SupplementItem;
      if (mix.parts === undefined) throw new BadRequestException(`${mix.name} is not a mix`);
      const back = state.folded.filter((f) => f.mixId === id).map((f) => f.item);
      state.folded = state.folded.filter((f) => f.mixId !== id);
      const { parts, ...own } = mix;
      const keep = parts.some((p) => p.itemId === id) ? [own] : [];
      state.items.splice(index, 1, ...keep, ...back);
      return [{ type: 'mix_split', date, mixId: id }];
    });
  }

  private async write(user: AuthUser, todayParam: string | undefined, plan: Plan): Promise<SupplementStackResponse> {
    const date = todayParam === undefined ? toIsoDate(new Date()) : parseIsoDateParam('today', todayParam);
    const repo = (await this.factory.forUser(user)).supplement;
    const state = await repo.load();
    const changes = plan(state, date);
    const errors = validateStack(state.items, state.dayTypes);
    if (errors.length > 0) throw new BadRequestException(errors);
    try {
      await repo.save(state, changes);
    } catch (err) {
      if (err instanceof SupplementWriteConflictError) throw new ConflictException(err.message);
      throw err;
    }
    return view(state);
  }
}
