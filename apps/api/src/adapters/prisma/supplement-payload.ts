import { Prisma } from '@prisma/client';
import {
  INGREDIENT_UNITS,
  Ingredient,
  SUPPLEMENT_SLOTS,
  SupplementChange,
  SupplementDayType,
  SupplementDose,
  SupplementItem,
  SupplementItemDetails,
  SupplementLink,
  SupplementPart,
  SupplementReference,
  SupplementStatus,
  EVIDENCE_LEVELS,
} from '@lifting-logbook/types';

/*
 * Reads the supplement change log's `payload` column and the item columns back into typed
 * values (#1374, ADR-046). A change is stored once and read for as long as the user keeps their
 * history, so a field a later version adds is filled with its default when an older entry
 * lacks it: restoring an item removed before #1377 must still give a whole item. A field present
 * with the wrong type is corruption, and throws rather than guessing.
 */

type Json = Prisma.JsonValue;
type JsonObject = Prisma.JsonObject;

const STATUSES: readonly SupplementStatus[] = ['active', 'pending'];

/** A stored supplement value that isn't the shape its type says. */
export class MalformedSupplementDataError extends Error {
  constructor(what: string) {
    super(`Malformed supplement data: ${what}`);
    this.name = 'MalformedSupplementDataError';
  }
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: Json | undefined, what: string): JsonObject {
  if (!isObject(value)) throw new MalformedSupplementDataError(`${what} is not an object`);
  return value;
}

function array(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new MalformedSupplementDataError(`${what} is not an array`);
  return value;
}

/** `o[key]` as a string; `fallback` when absent, and required when there's none. */
function string(o: JsonObject, key: string, fallback?: string): string {
  const value = o[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new MalformedSupplementDataError(`${key} is not a string`);
  return value;
}

function number(o: JsonObject, key: string): number {
  const value = o[key];
  if (typeof value !== 'number') throw new MalformedSupplementDataError(`${key} is not a number`);
  return value;
}

function boolean(o: JsonObject, key: string, fallback: boolean): boolean {
  const value = o[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new MalformedSupplementDataError(`${key} is not a boolean`);
  return value;
}

/**
 * Links as a change recorded them: `{label, url}` objects, or, before #1409, plain URL strings,
 * read as an empty label. The change log is append-only, so old entries are read, never rewritten.
 */
export function parseLinks(value: Json | undefined): SupplementLink[] {
  return array(value, 'links').map((entry) => {
    if (typeof entry === 'string') return { label: '', url: entry };
    const o = object(entry, 'a link');
    return { label: string(o, 'label', ''), url: string(o, 'url') };
  });
}

function strings(value: Json | undefined, what: string): string[] {
  return array(value, what).map((s) => {
    if (typeof s !== 'string') throw new MalformedSupplementDataError(`${what} holds a non-string`);
    return s;
  });
}

/** One of `allowed`, found by value so the result has its type. */
function oneOf<T extends string>(allowed: readonly T[], value: unknown, what: string): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined) throw new MalformedSupplementDataError(`${what} "${String(value)}" is not one of ${allowed.join(', ')}`);
  return found;
}

export const parseStatus = (value: unknown): SupplementStatus => oneOf(STATUSES, value, 'status');
export const parseSlot = (value: unknown): SupplementDose['slot'] => oneOf(SUPPLEMENT_SLOTS, value, 'slot');

export function parseIngredients(value: Json | undefined): Ingredient[] {
  return array(value, 'ingredients').map((entry) => {
    const o = object(entry, 'an ingredient');
    return { key: string(o, 'key'), amount: number(o, 'amount'), unit: oneOf(INGREDIENT_UNITS, o.unit, 'unit') };
  });
}

function parseDoses(value: Json | undefined): SupplementDose[] {
  return array(value, 'doses').map((entry) => {
    const o = object(entry, 'a dose');
    return {
      slot: parseSlot(o.slot),
      amount: string(o, 'amount', ''),
      servings: number(o, 'servings'),
      dayTypes: o.dayTypes === undefined ? [] : strings(o.dayTypes, 'dayTypes'),
    };
  });
}

function parseParts(value: Json | undefined): SupplementPart[] {
  return array(value, 'parts').map((entry) => {
    const o = object(entry, 'a mix part');
    return {
      itemId: string(o, 'itemId'),
      name: string(o, 'name', ''),
      ingredients: o.ingredients === undefined ? [] : parseIngredients(o.ingredients),
    };
  });
}

/**
 * An item's catalog reference snapshot (#1375). Like an item, it's kept in the change log for good,
 * so every field but `evidence` falls back to its default, and a field added later must too.
 */
export function parseReference(value: Json | undefined): SupplementReference {
  const o = object(value, 'reference');
  const evidence = object(o.evidence, 'evidence');
  return {
    uses: o.uses === undefined ? [] : strings(o.uses, 'uses'),
    evidence: { level: oneOf(EVIDENCE_LEVELS, evidence.level, 'evidence level'), reason: string(evidence, 'reason', '') },
    cautions: o.cautions === undefined ? [] : strings(o.cautions, 'cautions'),
    typicalRange: string(o, 'typicalRange', ''),
    sources: o.sources === undefined ? [] : strings(o.sources, 'sources'),
  };
}

/** An item as a change recorded it, with every field an older entry lacks at its default. */
export function parseItem(value: Json | undefined): SupplementItem {
  const o = object(value, 'item');
  return {
    id: string(o, 'id'),
    name: string(o, 'name', ''),
    keyCompound: string(o, 'keyCompound', ''),
    timing: string(o, 'timing', ''),
    shortNote: string(o, 'shortNote', ''),
    longNote: string(o, 'longNote', ''),
    status: o.status === undefined ? 'active' : parseStatus(o.status),
    unverified: boolean(o, 'unverified', false),
    links: o.links === undefined ? [] : parseLinks(o.links),
    category: string(o, 'category', ''),
    typicalRange: string(o, 'typicalRange', ''),
    ingredients: o.ingredients === undefined ? [] : parseIngredients(o.ingredients),
    ...(o.parts === undefined ? {} : { parts: parseParts(o.parts) }),
    ...(o.catalogKey === undefined ? {} : { catalogKey: string(o, 'catalogKey') }),
    ...(o.reference === undefined ? {} : { reference: parseReference(o.reference) }),
    doses: o.doses === undefined ? [] : parseDoses(o.doses),
  };
}

const DETAIL_KEYS = ['name', 'keyCompound', 'timing', 'shortNote', 'longNote', 'category', 'typicalRange'] as const;

function parseDetails(value: Json | undefined): Partial<SupplementItemDetails> {
  const o = object(value, 'changes');
  const details: Partial<SupplementItemDetails> = {};
  for (const key of DETAIL_KEYS) if (o[key] !== undefined) details[key] = string(o, key);
  if (o.links !== undefined) details.links = parseLinks(o.links);
  if (o.ingredients !== undefined) details.ingredients = parseIngredients(o.ingredients);
  return details;
}

function parseDayTypes(value: Json | undefined): SupplementDayType[] {
  return array(value, 'dayTypes').map((entry) => {
    const o = object(entry, 'a day type');
    const sessionTime = o.sessionTime === undefined ? undefined : string(o, 'sessionTime');
    return { id: string(o, 'id'), name: string(o, 'name'), ...(sessionTime === undefined ? {} : { sessionTime }) };
  });
}

/** A `supplement_change` row as the change it records. */
export function parseChange(row: { type: string; date: string; seq: number; payload: Json }): SupplementChange {
  const { date, seq } = row;
  const p = object(row.payload, `change ${seq}'s payload`);
  switch (row.type) {
    case 'added':
      return { date, seq, type: 'added', item: parseItem(p.item), ...(p.note === undefined ? {} : { note: string(p, 'note') }) };
    case 'edited':
      return { date, seq, type: 'edited', itemId: string(p, 'itemId'), changes: parseDetails(p.changes) };
    case 'moved':
      return { date, seq, type: 'moved', itemId: string(p, 'itemId'), doses: parseDoses(p.doses) };
    case 'started':
    case 'moved_to_pending':
    case 'restored':
    case 'confirmed':
      return { date, seq, type: row.type, itemId: string(p, 'itemId') };
    case 'removed':
      return { date, seq, type: 'removed', item: parseItem(p.item) };
    case 'mix_created':
      return { date, seq, type: 'mix_created', mix: parseItem(p.mix), partIds: strings(p.partIds, 'partIds') };
    case 'folded_into_mix':
      return { date, seq, type: 'folded_into_mix', mixId: string(p, 'mixId'), itemId: string(p, 'itemId') };
    case 'mix_split':
      return { date, seq, type: 'mix_split', mixId: string(p, 'mixId') };
    case 'day_types_set':
      return { date, seq, type: 'day_types_set', dayTypes: parseDayTypes(p.dayTypes) };
    case 'caffeine_cutoff_set':
      return { date, seq, type: 'caffeine_cutoff_set', caffeineCutoff: string(p, 'caffeineCutoff') };
    default:
      throw new MalformedSupplementDataError(`change ${seq} has unknown type "${row.type}"`);
  }
}

/**
 * `value` as JSON Prisma can store, checked rather than cast: our supplement values hold only
 * strings, numbers, booleans, arrays and plain objects. An `undefined` property is left out, as
 * JSON.stringify would.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = toJson(v);
    return out;
  }
  throw new MalformedSupplementDataError(`a ${value === null ? 'null' : typeof value} can't be stored as JSON`);
}
