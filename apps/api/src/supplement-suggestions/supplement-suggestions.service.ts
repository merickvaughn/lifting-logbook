import { Inject, Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  IMPORT_SUGGESTION_DEADLINE_MS,
  SUPPLEMENT_LABEL_LOOKUP_HOURLY_LIMIT,
  SUPPLEMENT_SUGGESTION_HOURLY_LIMIT,
  type SupplementAiSuggestionResponse,
  type SupplementLabelLookupResponse,
} from '@lifting-logbook/types';
import type {
  IImportSuggestionProvider,
  IImportSuggestionUsage,
  ISupplementLabelLookup,
} from '../ports';
import { IMPORT_SUGGESTION_PROVIDER, SUPPLEMENT_LABEL_LOOKUP, SUPPLEMENT_SUGGESTION_USAGE } from '../ports/tokens';
import { InMemoryImportSuggestionUsage } from '../import-suggestions/import-suggestion-usage';
import { buildSupplementPayload, sentName } from './supplement-suggestion-payload';
import { SUPPLEMENT_RESPONSE_SCHEMA, SUPPLEMENT_SYSTEM_PROMPT } from './supplement-suggestion-prompt';
import { validateSupplementSuggestion } from './supplement-suggestion-validation';

/** The most tokens the model may return for one supplement. */
export const SUPPLEMENT_MAX_OUTPUT_TOKENS = 800;

/** What the forced tool call returns, for a provider that names it. */
export const SUPPLEMENT_TOOL_DESCRIPTION = 'Return the supplement suggestion for the lifter to review.';

const errorName = (err: unknown) => (err instanceof Error ? err.name : typeof err);
const retryAfterMinutes = (retryAt: Date, now: Date) => Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));

/**
 * Tiers 2 and 3 of the supplement suggestions (#1381), used when the shared catalog has no match.
 * Logs and spans carry counts and outcomes only: never the typed name, a prompt or a reply
 * (CLAUDE.md, Observability item 2).
 */
@Injectable()
export class SupplementSuggestionsService {
  private readonly logger = new Logger(SupplementSuggestionsService.name);
  private readonly tracer = trace.getTracer('supplement-suggestions');
  /** Label lookups per lifter in the last hour; the same sliding window the in-memory AI count uses. */
  private readonly lookups = new InMemoryImportSuggestionUsage();

  constructor(
    @Inject(SUPPLEMENT_LABEL_LOOKUP) private readonly labels: ISupplementLabelLookup,
    @Inject(IMPORT_SUGGESTION_PROVIDER) private readonly provider: IImportSuggestionProvider | null,
    @Inject(SUPPLEMENT_SUGGESTION_USAGE) private readonly usage: IImportSuggestionUsage,
  ) {}

  /**
   * Tier 2. An outage is logged and answered `unavailable`, so the form still offers tier 3. Each
   * lifter gets `SUPPLEMENT_LABEL_LOOKUP_HOURLY_LIMIT` lookups an hour, counted in this process.
   */
  async labelLookup(params: { userId: string; name: string; now?: Date }): Promise<SupplementLabelLookupResponse> {
    const started = Date.now();
    if (sentName(params.name) === '') return { status: 'none' };
    const now = params.now ?? new Date();
    const allowance = await this.lookups.tryConsume(params.userId, now, SUPPLEMENT_LABEL_LOOKUP_HOURLY_LIMIT);
    if (!allowance.allowed) {
      this.logger.log({ tier: 'label', outcome: 'limited', durationMs: Date.now() - started }, 'Supplement suggestions (#1381)');
      return { status: 'limited', retryAfterMinutes: retryAfterMinutes(allowance.retryAt, now) };
    }
    try {
      const suggestions = await this.labels.lookup(params.name);
      this.logger.log({ tier: 'label', outcome: suggestions.length > 0 ? 'ready' : 'none', suggestions: suggestions.length, durationMs: Date.now() - started }, 'Supplement suggestions (#1381)');
      return suggestions.length > 0 ? { status: 'ready', suggestions } : { status: 'none' };
    } catch (err) {
      this.logger.warn({ tier: 'label', outcome: 'unavailable', error: errorName(err), durationMs: Date.now() - started }, 'Supplement label lookup failed (#1381)');
      return { status: 'unavailable' };
    }
  }

  /** Tier 3. The caller saves what it returns unverified. */
  async aiSuggest(params: { userId: string; name: string; signal?: AbortSignal; now?: Date }): Promise<SupplementAiSuggestionResponse> {
    const started = Date.now();
    const provider = this.provider;
    const log = (fields: Record<string, unknown>) =>
      this.logger.log({ tier: 'ai', provider: provider?.kind ?? null, ...fields, durationMs: Date.now() - started }, 'Supplement suggestions (#1381)');
    if (!provider) {
      log({ outcome: 'off' });
      return { status: 'off' };
    }
    const payload = buildSupplementPayload(params.name);
    if (payload.untrustedName === '') {
      log({ outcome: 'none', suggestions: 0 });
      return { status: 'none' };
    }
    const now = params.now ?? new Date();
    const allowance = await this.usage.tryConsume(params.userId, now, SUPPLEMENT_SUGGESTION_HOURLY_LIMIT);
    if (!allowance.allowed) {
      log({ outcome: 'limited' });
      return { status: 'limited', retryAfterMinutes: retryAfterMinutes(allowance.retryAt, now) };
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('deadline')), IMPORT_SUGGESTION_DEADLINE_MS);
    const onAbort = () => deadline.abort(new Error('client-left'));
    if (params.signal?.aborted) onAbort();
    else params.signal?.addEventListener('abort', onAbort, { once: true });
    let result;
    try {
      result = await this.tracer.startActiveSpan('supplement.suggestions.provider_call', async (span) => {
        span.setAttribute('supplement_suggestions.provider', provider.kind);
        try {
          const out = await provider.suggest(
            {
              system: SUPPLEMENT_SYSTEM_PROMPT,
              payload,
              maxOutputTokens: SUPPLEMENT_MAX_OUTPUT_TOKENS,
              schema: SUPPLEMENT_RESPONSE_SCHEMA,
              toolDescription: SUPPLEMENT_TOOL_DESCRIPTION,
            },
            deadline.signal,
          );
          span.setAttribute('supplement_suggestions.truncated', out.truncated);
          return out;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorName(err) });
          throw err;
        } finally {
          span.end();
        }
      });
    } catch (err) {
      const reason = deadline.signal.aborted && (deadline.signal.reason as Error)?.message === 'deadline' ? 'timeout' : 'error';
      this.logger.warn({ tier: 'ai', provider: provider.kind, outcome: reason, error: errorName(err), durationMs: Date.now() - started }, 'Supplement suggestions failed (#1381)');
      return { status: 'unavailable', reason };
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
    }

    const suggestion = result.truncated ? null : validateSupplementSuggestion(result.output);
    log({
      outcome: suggestion ? 'ready' : 'none',
      suggestions: suggestion ? 1 : 0,
      ingredients: suggestion?.ingredients.length ?? 0,
      sources: suggestion?.sources.length ?? 0,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      truncated: result.truncated,
    });
    return suggestion ? { status: 'ready', provider: provider.label, suggestion } : { status: 'none' };
  }
}
