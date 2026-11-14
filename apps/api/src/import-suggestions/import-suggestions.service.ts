import { Inject, Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  IMPORT_SUGGESTION_HOURLY_LIMIT,
  IMPORT_SUGGESTION_MAX_SETS,
  type ImportSuggestionsResponse,
} from '@lifting-logbook/types';
import type { SegmentedLiftHistory } from '@lifting-logbook/core';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { IMPORT_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';
import type {
  IImportSuggestionProvider,
  IImportSuggestionUsage,
  ImportSuggestionCallResult,
} from '../ports/IImportSuggestionProvider';
import { IMPORT_SUGGESTION_PROVIDER, IMPORT_SUGGESTION_USAGE } from '../ports/tokens';
import { SUGGESTION_SYSTEM_PROMPT } from './suggestion-prompt';
import { buildSuggestionPayload, type SuggestionProgram, type SuggestionRow } from './suggestion-payload';
import { validateSuggestions } from './suggestion-validation';

/** How long the model gets (decision 12). There are no retries. */
export const SUGGESTION_DEADLINE_MS = 60_000;
/** The most tokens the model may return (decision 11). */
export const SUGGESTION_MAX_OUTPUT_TOKENS = 2_000;

/** What a suggestion request reads from the database: the file's rules grouping and its context. */
export interface SuggestionSource {
  segmented: SegmentedLiftHistory<SuggestionRow>;
  importDate: Date;
  programs: readonly SuggestionProgram[];
  exported: boolean;
  /** The lifter's names for their lifts by id, custom ones included. */
  liftNames: ReadonlyMap<string, string>;
}

/**
 * The import wizard's optional LLM suggestions (#1174, proposal decisions 11 and 12). The rules'
 * grouping is computed and returned by `mode=assign` without this; this only reads it.
 *
 * Database work runs in short transactions of its own, before the provider call, so no connection
 * is held while the model works (#518). The provider gets one call with a 60-second deadline and
 * no retries, and its answer is validated against the file's rows. Logs carry counts only: never
 * the payload, a prompt or a response.
 */
@Injectable()
export class ImportSuggestionsService {
  private readonly logger = new Logger(ImportSuggestionsService.name);
  private readonly tracer = trace.getTracer('import-suggestions');

  constructor(
    @Inject(IMPORT_SUGGESTION_PROVIDER) private readonly provider: IImportSuggestionProvider | null,
    @Inject(IMPORT_SUGGESTION_USAGE) private readonly usage: IImportSuggestionUsage,
    private readonly rls: RlsContextService,
  ) {}

  /** Who suggestions go to, for the Assign response; null when they're off. */
  get providerLabel(): string | null {
    return this.provider?.label ?? null;
  }

  async suggest(params: {
    userId: string;
    notes: boolean;
    /** Reads the file's grouping. Runs in its own short transaction as the user. */
    load: () => Promise<SuggestionSource>;
    /** Aborts the provider call, such as when the lifter leaves the step. */
    signal?: AbortSignal;
    now?: Date;
  }): Promise<ImportSuggestionsResponse> {
    const started = Date.now();
    const provider = this.provider;
    if (!provider) {
      this.logger.log({ outcome: 'off' }, 'Import suggestions (#1174)');
      return { status: 'off' };
    }

    const source = await this.rls.withUserContext(params.load, IMPORT_TX_TIMEOUT_MS);
    const { segmented } = source;
    const built = buildSuggestionPayload(
      {
        segmented,
        importDate: source.importDate,
        programs: source.programs,
        exported: source.exported,
        notes: params.notes,
      },
      source.liftNames,
    );
    // Counts only: rows, lift names, notes, the payload and the response are the lifter's data.
    const counts = {
      provider: provider.kind,
      sessions: built.payload.sessions.length,
      stretches: segmented.stretches.length,
      flags: segmented.lone.length + built.payload.flags.unnumbered.length + segmented.conflicts.length,
      setsSent: built.sets,
      summarizedSessions: built.summarizedSessions,
      notesSent: params.notes,
    };
    const log = (fields: Record<string, unknown>) =>
      this.logger.log({ ...counts, ...fields, durationMs: Date.now() - started }, 'Import suggestions (#1174)');

    if (!built.fits) {
      log({ outcome: 'too-large' });
      return { status: 'too-large', sets: built.sets, limit: IMPORT_SUGGESTION_MAX_SETS };
    }

    // A lifter who left while the file was read hasn't reached the provider, so nothing is counted
    // (decision 3 counts a request once it's about to be sent). Nobody is waiting for the answer.
    if (params.signal?.aborted) {
      log({ outcome: 'aborted' });
      return { status: 'unavailable', reason: 'error' };
    }

    const now = params.now ?? new Date();
    const allowance = await this.usage.tryConsume(params.userId, now, IMPORT_SUGGESTION_HOURLY_LIMIT);
    if (!allowance.allowed) {
      log({ outcome: 'limited' });
      return {
        status: 'limited',
        retryAfterMinutes: Math.max(1, Math.ceil((allowance.retryAt.getTime() - now.getTime()) / 60_000)),
      };
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('deadline')), SUGGESTION_DEADLINE_MS);
    const onAbort = () => deadline.abort(new Error('client-left'));
    if (params.signal?.aborted) onAbort();
    else params.signal?.addEventListener('abort', onAbort, { once: true });

    const callStarted = Date.now();
    let result: ImportSuggestionCallResult;
    // Only the provider call is caught: an error in validating its answer is this code's bug, not a
    // provider outage, and surfaces as a 500 with its stack.
    try {
      result = await this.tracer.startActiveSpan('import.suggestions.provider_call', async (span) => {
        span.setAttributes({
          'import_suggestions.provider': provider.kind,
          'import_suggestions.sets_sent': built.sets,
          'import_suggestions.summarized_sessions': built.summarizedSessions,
          'import_suggestions.notes_sent': params.notes,
        });
        try {
          const out = await provider.suggest(
            { system: SUGGESTION_SYSTEM_PROMPT, payload: built.payload, maxOutputTokens: SUGGESTION_MAX_OUTPUT_TOKENS },
            deadline.signal,
          );
          if (out.inputTokens !== null) span.setAttribute('import_suggestions.input_tokens', out.inputTokens);
          if (out.outputTokens !== null) span.setAttribute('import_suggestions.output_tokens', out.outputTokens);
          span.setAttribute('import_suggestions.truncated', out.truncated);
          return out;
        } catch (err) {
          // The error's type only: a provider's message can quote the request.
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorName(err) });
          throw err;
        } finally {
          span.end();
        }
      });
    } catch (err) {
      const reason = deadline.signal.aborted && (deadline.signal.reason as Error)?.message === 'deadline' ? 'timeout' : 'error';
      const fields = {
        ...counts,
        error: errorName(err),
        providerMs: Date.now() - callStarted,
        durationMs: Date.now() - started,
      };
      // Leaving the step is ordinary navigation, not a failure.
      if (params.signal?.aborted) this.logger.log({ ...fields, outcome: 'aborted' }, 'Import suggestions (#1174)');
      else this.logger.warn({ ...fields, outcome: reason }, 'Import suggestions failed (#1174)');
      return { status: 'unavailable', reason };
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
    }

    const validated = validateSuggestions(result.output, segmented, built, source.exported);
    log({
      outcome: 'ready',
      providerMs: Date.now() - callStarted,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      truncated: result.truncated,
      suggestions: validated.suggestions.length,
      droppedMalformed: validated.dropped.malformed,
      droppedUnknownLift: validated.dropped['unknown-lift'],
      droppedOutOfRange: validated.dropped['out-of-range'],
    });
    return {
      status: 'ready',
      provider: provider.label,
      notesSent: params.notes,
      summarizedSessions: built.summarizedSessions,
      suggestions: validated.suggestions,
      dropped: validated.dropped,
    };
  }
}

function errorName(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? `${err.name} (HTTP ${status})` : err.name;
  }
  return typeof err;
}
