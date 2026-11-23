import { Logger } from '@nestjs/common';
import type { SupplementSuggestion } from '@lifting-logbook/types';
import { SUPPLEMENT_SUGGESTION_HOURLY_LIMIT } from '@lifting-logbook/types';
import { InMemoryImportSuggestionUsage } from '../import-suggestions/import-suggestion-usage';
import type { IImportSuggestionProvider } from '../ports';
import { SUPPLEMENT_SYSTEM_PROMPT } from './supplement-suggestion-prompt';
import { SupplementSuggestionsService } from './supplement-suggestions.service';

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
    it('returns the labels found', async () => {
      expect(await build().service.labelLookup(TYPED)).toEqual({ status: 'ready', suggestions: [suggestion] });
    });

    it('answers none for no labels and for a blank name, without calling the database', async () => {
      const labels = jest.fn().mockResolvedValue([]);
      const { service } = build({ labels });
      expect(await service.labelLookup(TYPED)).toEqual({ status: 'none' });
      expect(await service.labelLookup('  ')).toEqual({ status: 'none' });
      expect(labels).toHaveBeenCalledTimes(1);
    });

    it('answers unavailable on an outage and logs it, without the name', async () => {
      const { service } = build({ labels: async () => Promise.reject(new TypeError(`fetch failed for ${TYPED}`)) });
      expect(await service.labelLookup(TYPED)).toEqual({ status: 'unavailable' });
      const warned = logs.find((l) => typeof l[1] === 'string' && l[1].includes('lookup failed'));
      expect(warned?.[0]).toMatchObject({ tier: 'label', outcome: 'unavailable', error: 'TypeError' });
      expect(JSON.stringify(logs)).not.toContain('Zorblax');
    });
  });

  describe('tier 3, AI', () => {
    it('sends the system prompt and only the allow-listed payload, and returns the validated suggestion', async () => {
      const { service, suggest } = build();
      const out = await service.aiSuggest({ userId: 'u1', name: TYPED });
      const [call] = suggest?.mock.calls[0] as [{ system: string; payload: unknown; schema: unknown }];
      expect(call.system).toBe(SUPPLEMENT_SYSTEM_PROMPT);
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
