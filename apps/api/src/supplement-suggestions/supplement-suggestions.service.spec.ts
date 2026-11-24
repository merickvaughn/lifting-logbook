import { Logger } from '@nestjs/common';
import type { SupplementSuggestion } from '@lifting-logbook/types';
import {
  IMPORT_SUGGESTION_DEADLINE_MS,
  SUPPLEMENT_LABEL_LOOKUP_HOURLY_LIMIT,
  SUPPLEMENT_SUGGESTION_HOURLY_LIMIT,
} from '@lifting-logbook/types';
import { InMemoryImportSuggestionUsage } from '../import-suggestions/import-suggestion-usage';
import type { IImportSuggestionProvider } from '../ports';
import { SUPPLEMENT_SYSTEM_PROMPT } from './supplement-suggestion-prompt';
import { SUPPLEMENT_TOOL_DESCRIPTION, SupplementSuggestionsService } from './supplement-suggestions.service';

const TYPED = 'Zorblax Ultra Secret Blend';
const REPLY = 'Zorblax reply-marker';
const suggestion: SupplementSuggestion = {
  name: 'Label product',
  keyCompound: 'X',
  suggestedDose: '1 scoop',
  timing: '',
  suggestedSlot: 'all',
  typicalRange: '',
  ingredients: [{ key: 'x', amount: 1, unit: 'g' }],
  productType: '',
  sources: [],
};
const aiReply = { suggestion: { name: REPLY, ingredients: [{ key: 'x', amount: 2, unit: 'g' }], sources: [{ label: 'a', url: 'https://example.org/a' }] } };

function build(opts: { labels?: () => Promise<SupplementSuggestion[]>; provider?: Partial<IImportSuggestionProvider> | null } = {}) {
  const suggest = jest.fn().mockResolvedValue({ output: aiReply, inputTokens: 100, outputTokens: 20, truncated: false });
  const provider = opts.provider === null ? null : ({ kind: 'anthropic', label: 'Anthropic (test)', suggest, ...opts.provider } as IImportSuggestionProvider);
  const service = new SupplementSuggestionsService(
    { lookup: opts.labels ?? (async () => [suggestion]) },
    provider,
    new InMemoryImportSuggestionUsage(),
  );
  return { service, suggest: provider?.suggest as jest.Mock | undefined };
}

describe('SupplementSuggestionsService (#1381)', () => {
  let logs: unknown[][];
  beforeEach(() => {
    logs = [];
    for (const m of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => void logs.push(args));
    }
  });
  afterEach(() => jest.restoreAllMocks());

  describe('tier 2, label lookup', () => {
    const lookup = (service: SupplementSuggestionsService, name = TYPED, userId = 'u1', now?: Date) =>
      service.labelLookup({ userId, name, ...(now ? { now } : {}) });

    it('returns the labels found', async () => {
      expect(await lookup(build().service)).toEqual({ status: 'ready', suggestions: [suggestion] });
    });

    it('answers none for no labels and for a blank name, without calling the database', async () => {
      const labels = jest.fn().mockResolvedValue([]);
      const { service } = build({ labels });
      expect(await lookup(service)).toEqual({ status: 'none' });
      expect(await lookup(service, '  ')).toEqual({ status: 'none' });
      expect(labels).toHaveBeenCalledTimes(1);
    });

    it('limits a lifter to the hourly lookups, apart from other lifters, without calling the database', async () => {
      const labels = jest.fn().mockResolvedValue([suggestion]);
      const { service } = build({ labels });
      const now = new Date('2026-11-23T10:00:00Z');
      for (let i = 0; i < SUPPLEMENT_LABEL_LOOKUP_HOURLY_LIMIT; i++) {
        expect((await lookup(service, TYPED, 'u1', new Date(now.getTime() + i * 1_000))).status).toBe('ready');
      }
      expect(await lookup(service, TYPED, 'u1', new Date(now.getTime() + 15 * 60_000))).toEqual({ status: 'limited', retryAfterMinutes: 45 });
      expect(labels).toHaveBeenCalledTimes(SUPPLEMENT_LABEL_LOOKUP_HOURLY_LIMIT);
      expect((await lookup(service, TYPED, 'u2', now)).status).toBe('ready');
      // A blank name answers none without counting.
      expect(await lookup(service, ' ', 'u1', now)).toEqual({ status: 'none' });
      expect((await lookup(service, TYPED, 'u1', new Date(now.getTime() + 60 * 60_000))).status).toBe('ready');
      expect(JSON.stringify(logs)).not.toContain('Zorblax');
    });

    it('answers unavailable on an outage and logs it, without the name', async () => {
      const { service } = build({ labels: async () => Promise.reject(new TypeError(`fetch failed for ${TYPED}`)) });
      expect(await lookup(service)).toEqual({ status: 'unavailable' });
      const warned = logs.find((l) => typeof l[1] === 'string' && l[1].includes('lookup failed'));
      expect(warned?.[0]).toMatchObject({ tier: 'label', outcome: 'unavailable', error: 'TypeError' });
      expect(JSON.stringify(logs)).not.toContain('Zorblax');
    });
  });

  describe('tier 3, AI', () => {
    it('sends the system prompt and only the allow-listed payload, and returns the validated suggestion', async () => {
      const { service, suggest } = build();
      const out = await service.aiSuggest({ userId: 'u1', name: TYPED });
      const [call] = suggest?.mock.calls[0] as [{ system: string; payload: unknown; schema: unknown; toolDescription: string }];
      expect(call.system).toBe(SUPPLEMENT_SYSTEM_PROMPT);
      expect(call.toolDescription).toBe(SUPPLEMENT_TOOL_DESCRIPTION);
      expect(call.payload).toEqual({ untrustedName: TYPED });
      expect(call.schema).toBeDefined();
      expect(out).toMatchObject({ status: 'ready', provider: 'Anthropic (test)', suggestion: { name: REPLY, sources: [{ url: 'https://example.org/a' }] } });
    });

    it('is off with no provider, and calls nothing', async () => {
      expect(await build({ provider: null }).service.aiSuggest({ userId: 'u1', name: TYPED })).toEqual({ status: 'off' });
    });

    it('answers none for a malformed reply or a truncated one', async () => {
      const bad = build({ provider: { suggest: jest.fn().mockResolvedValue({ output: 'sorry', inputTokens: null, outputTokens: null, truncated: false }) } });
      expect(await bad.service.aiSuggest({ userId: 'u1', name: TYPED })).toEqual({ status: 'none' });
      const cut = build({ provider: { suggest: jest.fn().mockResolvedValue({ output: aiReply, inputTokens: 1, outputTokens: 1, truncated: true }) } });
      expect(await cut.service.aiSuggest({ userId: 'u1', name: TYPED })).toEqual({ status: 'none' });
    });

    it('limits a lifter to the hourly allowance and reports when to retry', async () => {
      const { service, suggest } = build();
      const now = new Date('2026-11-23T10:00:00Z');
      for (let i = 0; i < SUPPLEMENT_SUGGESTION_HOURLY_LIMIT; i++) {
        expect((await service.aiSuggest({ userId: 'u1', name: TYPED, now })).status).toBe('ready');
      }
      const limited = await service.aiSuggest({ userId: 'u1', name: TYPED, now: new Date(now.getTime() + 10 * 60_000) });
      expect(limited).toEqual({ status: 'limited', retryAfterMinutes: 50 });
      expect(suggest).toHaveBeenCalledTimes(SUPPLEMENT_SUGGESTION_HOURLY_LIMIT);
      expect((await service.aiSuggest({ userId: 'u2', name: TYPED, now })).status).toBe('ready');
    });

    it('answers unavailable when the provider fails, and logs the error type only', async () => {
      const { service } = build({ provider: { suggest: jest.fn().mockRejectedValue(Object.assign(new Error(`quota for ${TYPED}`), { name: 'RateLimitError' })) } });
      expect(await service.aiSuggest({ userId: 'u1', name: TYPED })).toEqual({ status: 'unavailable', reason: 'error' });
      expect(JSON.stringify(logs)).not.toContain('Zorblax');
      expect(logs.some((l) => (l[0] as { error?: string })?.error === 'RateLimitError')).toBe(true);
    });

    describe('the deadline', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      /** A provider that answers only by rejecting once its signal aborts. */
      const hanging = () =>
        jest.fn(
          (_call: unknown, signal: AbortSignal) =>
            new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })))),
        );

      it(`answers unavailable with reason timeout when the provider is still going at ${IMPORT_SUGGESTION_DEADLINE_MS} ms`, async () => {
        const suggest = hanging();
        const { service } = build({ provider: { suggest } });
        let settled = false;
        const pending = service.aiSuggest({ userId: 'u1', name: TYPED }).finally(() => (settled = true));
        await jest.advanceTimersByTimeAsync(IMPORT_SUGGESTION_DEADLINE_MS - 1);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual({ status: 'unavailable', reason: 'timeout' });
        expect((suggest.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
        expect(logs.some((l) => (l[0] as { outcome?: string })?.outcome === 'timeout')).toBe(true);
      });

      it('answers reason error, not timeout, when the client leaves first', async () => {
        const left = new AbortController();
        const { service } = build({ provider: { suggest: hanging() } });
        const pending = service.aiSuggest({ userId: 'u1', name: TYPED, signal: left.signal });
        await jest.advanceTimersByTimeAsync(10);
        left.abort();
        expect(await pending).toEqual({ status: 'unavailable', reason: 'error' });
      });
    });

    it('logs counts and outcomes only: never the typed name, the payload or the reply', async () => {
      await build().service.aiSuggest({ userId: 'u1', name: TYPED });
      const entry = logs.find((l) => (l[0] as { tier?: string })?.tier === 'ai')?.[0] as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toEqual(
        ['durationMs', 'inputTokens', 'ingredients', 'outcome', 'outputTokens', 'provider', 'sources', 'suggestions', 'tier', 'truncated'].sort(),
      );
      expect(entry).toMatchObject({ outcome: 'ready', suggestions: 1, ingredients: 1, sources: 1, provider: 'anthropic' });
      const text = JSON.stringify(logs);
      expect(text).not.toContain('Zorblax');
      expect(text).not.toContain('u1');
    });
  });
});
