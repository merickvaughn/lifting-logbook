import { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { SUPPLEMENT_TEXT_MAX, type Ingredient, type SupplementSuggestion } from '@lifting-logbook/types';
import type { ISupplementLabelLookup } from '../ports/ISupplementLabelLookup';
import { MAX_INGREDIENTS, cleanIngredient, clip } from './suggestion-shape';
import { sentName } from './supplement-suggestion-payload';

/**
 * Tier 2 of the supplement suggestions (#1381): the NIH Dietary Supplement Label Database, v9.
 * Calls go to `DSLD_BASE_URL` (https://api.ods.od.nih.gov/dsld/v9); https://dsldapi.od.nih.gov/
 * is the API's documentation site, not a host this calls. `search-filter` finds labels by name and
 * `label/{id}` gives each one's serving size, product type and ingredient rows. Only the typed name
 * is sent, as the query. Each request has its own 4-second timeout, and a lookup is a search
 * followed by up to three label fetches in parallel, so one takes about 8 seconds at worst.
 *
 * Answers are cached in process (a bounded LRU with a TTL, no table), identical lookups in flight
 * share one request, and after a failed search every lookup rejects at once for
 * `OUTAGE_BACKOFF_MS` rather than calling again. A failure rejects so the service can fall through
 * to tier 3.
 */
export const DSLD_BASE_URL = 'https://api.ods.od.nih.gov/dsld/v9';
export const DSLD_LABEL_PAGE = 'https://dsld.od.nih.gov/label';
const LABELS_PER_LOOKUP = 3;
const TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const CACHE_MAX = 200;
/** How long lookups reject without calling after a failed one. */
export const OUTAGE_BACKOFF_MS = 30_000;

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Thrown while the label database is treated as down after a failed lookup. */
export class DsldUnavailableError extends Error {
  override readonly name = 'DsldUnavailableError';
}

/** A DSLD unit such as "Milligram(s)" or "mcg" as one of the app's units; null for IU, CFU and the like. */
export function dsldUnit(unit: unknown): Ingredient['unit'] | null {
  if (typeof unit !== 'string') return null;
  const u = unit.trim().toLowerCase();
  if (/^(mg|milligram)/.test(u)) return 'mg';
  if (/^(mcg|µg|μg|ug|microgram)/.test(u)) return 'mcg';
  if (/^(g|gram)/.test(u)) return 'g';
  return null;
}

/** One label (`label/{id}`) as a catalog-shaped suggestion; null when it names nothing usable. */
export function labelToSuggestion(id: string, label: unknown): SupplementSuggestion | null {
  if (!isRecord(label)) return null;
  const name = clip(label.fullName, SUPPLEMENT_TEXT_MAX.name);
  if (name === '') return null;
  const rows = Array.isArray(label.ingredientRows) ? label.ingredientRows : [];
  const ingredients: Ingredient[] = [];
  let keyCompound = '';
  for (const row of rows) {
    if (!isRecord(row)) continue;
    keyCompound ||= clip(row.name, SUPPLEMENT_TEXT_MAX.name);
    const q = Array.isArray(row.quantity) ? row.quantity.find(isRecord) : undefined;
    const unit = q ? dsldUnit(q.unit) : null;
    const ingredient = q && unit ? cleanIngredient(row.name, q.quantity, unit) : null;
    if (ingredient && !ingredients.some((i) => i.key === ingredient.key)) ingredients.push(ingredient);
  }
  const serving = Array.isArray(label.servingSizes) ? label.servingSizes.find(isRecord) : undefined;
  const qty = serving && typeof serving.minQuantity === 'number' ? serving.minQuantity : undefined;
  const servingUnit = serving ? clip(serving.unit, 40).replace(/\(s\)/gi, '').toLowerCase() : '';
  const productType = isRecord(label.productType) ? clip(label.productType.langualCodeDescription, 80) : '';
  return {
    name,
    keyCompound,
    suggestedDose: qty === undefined ? '' : `${qty} ${servingUnit}`.trim(),
    timing: '',
    suggestedSlot: 'all',
    typicalRange: '',
    ingredients: ingredients.slice(0, MAX_INGREDIENTS),
    productType,
    sources: [{ label: 'NIH Dietary Supplement Label Database', url: `${DSLD_LABEL_PAGE}/${encodeURIComponent(id)}` }],
  };
}

export class DsldLabelLookup implements ISupplementLabelLookup {
  private readonly logger = new Logger(DsldLabelLookup.name);
  private readonly tracer = trace.getTracer('supplement-suggestions');
  private readonly cache = new Map<string, { at: number; suggestions: SupplementSuggestion[] }>();
  private readonly inFlight = new Map<string, Promise<SupplementSuggestion[]>>();
  private outageUntil = 0;

  constructor(
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
    private readonly baseUrl: string = DSLD_BASE_URL,
  ) {}

  async lookup(typed: string): Promise<SupplementSuggestion[]> {
    const name = sentName(typed);
    const key = name.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) {
      // Re-insert so the least recently used entry is the first key.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.suggestions;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (this.now() < this.outageUntil) throw new DsldUnavailableError('DSLD failed recently; not called again yet');
    const request = this.fetchAndCache(name, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchAndCache(name: string, key: string): Promise<SupplementSuggestion[]> {
    let suggestions: SupplementSuggestion[];
    try {
      suggestions = await this.tracer.startActiveSpan('supplement.suggestions.dsld_lookup', async (span) => {
        try {
          const out = await this.fetchLabels(name);
          span.setAttribute('supplement_suggestions.labels', out.length);
          return out;
        } catch (err) {
          // The error's type only: nothing about the request goes in a span.
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.name : typeof err });
          throw err;
        } finally {
          span.end();
        }
      });
    } catch (err) {
      this.outageUntil = this.now() + OUTAGE_BACKOFF_MS;
      throw err;
    }
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), suggestions });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    return suggestions;
  }

  private async fetchLabels(name: string): Promise<SupplementSuggestion[]> {
    const search = await this.get(`/search-filter?q=${encodeURIComponent(name)}&size=${LABELS_PER_LOOKUP}`);
    const hits = isRecord(search) && Array.isArray(search.hits) ? search.hits : [];
    const ids = hits
      .map((h) => (isRecord(h) ? h._id : undefined))
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .slice(0, LABELS_PER_LOOKUP)
      .map(String);
    // One label that fails doesn't sink the others; only every label failing is an outage.
    const settled = await Promise.allSettled(
      ids.map(async (id) => labelToSuggestion(id, await this.get(`/label/${encodeURIComponent(id)}`))),
    );
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const [firstFailure] = failed;
    if (firstFailure) {
      this.logger.warn({ failed: failed.length, labels: ids.length }, 'DSLD label fetches failed (#1381)');
      if (failed.length === ids.length) throw firstFailure.reason;
    }
    return settled.flatMap((r) => (r.status === 'fulfilled' && r.value !== null ? [r.value] : []));
  }

  private async get(path: string): Promise<unknown> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { signal });
    if (!res.ok) {
      this.logger.warn({ status: res.status }, 'DSLD answered with an error (#1381)');
      throw new Error(`DSLD HTTP ${res.status}`);
    }
    return res.json();
  }
}
