import { Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {
  ALLOWED_PAYLOAD_PATHS,
  IMPORT_DATE,
  PROGRAMS,
  fiveThreeOne,
  payloadPaths,
  rowsOf,
  segment,
} from '../../testing/import-suggestion-fixtures';
import { buildSuggestionPayload } from '../../import-suggestions/suggestion-payload';
import { SUGGESTION_SYSTEM_PROMPT } from '../../import-suggestions/suggestion-prompt';
import { AnthropicImportSuggestionsAdapter } from './anthropic-import-suggestions.adapter';
import { OpenAICompatibleImportSuggestionsAdapter } from './openai-compatible-import-suggestions.adapter';
import { buildImportSuggestionProvider } from './import-suggestions-provider.factory';

const NOTE = 'left knee sore';
const CUSTOM_LIFT = 'Zercher Hold';
const CUSTOM_PROGRAM = 'My Secret Plan';

/** A file with a custom lift, notes on every set, and a custom program on offer. */
function call(notes: boolean) {
  const rows = rowsOf([...fiveThreeOne(0, 4, { notes: NOTE }), { day: 8, lifts: ['zercher-hold', 'back-squat'], notes: NOTE }]);
  const built = buildSuggestionPayload(
    {
      segmented: segment(rows),
      importDate: IMPORT_DATE,
      programs: [...PROGRAMS, { id: 'prog-abc123', name: CUSTOM_PROGRAM, workouts: 12, weeks: 6 }],
      exported: false,
      notes,
    },
    new Map([['zercher-hold', CUSTOM_LIFT]]),
  );
  return { system: SUGGESTION_SYSTEM_PROMPT, payload: built.payload, maxOutputTokens: 2_000 };
}

/** What a request body sent, checked against the allow-list. */
function expectAllowed(sentJson: string, notes: boolean) {
  const paths = payloadPaths(JSON.parse(sentJson));
  expect([...paths].filter((p) => !ALLOWED_PAYLOAD_PATHS.has(p))).toEqual([]);
  expect(paths.has('sessions[].sets[].notes')).toBe(notes);
  expect(sentJson.includes(NOTE)).toBe(notes);
  expect(sentJson).not.toContain(CUSTOM_LIFT);
  expect(sentJson).not.toContain(CUSTOM_PROGRAM);
  expect(sentJson).not.toContain('prog-abc123');
  expect(sentJson).toContain('custom-lift-1');
  expect(sentJson).toContain('custom-program-1');
}

describe('AnthropicImportSuggestionsAdapter (#1174)', () => {
  const answer = {
    content: [{ type: 'tool_use', id: 't1', name: 'suggest', input: { suggestions: [{ kind: 'note', text: 'x' }] } }],
    usage: { input_tokens: 900, output_tokens: 40 },
  };

  it.each([false, true])('sends only the allowed payload (notes %s) through a forced tool call', async (notes) => {
    const create = jest.fn().mockResolvedValue(answer);
    const adapter = new AnthropicImportSuggestionsAdapter('claude-test', 'key', { messages: { create } } as unknown as Pick<Anthropic, 'messages'>);
    const signal = new AbortController().signal;

    const result = await adapter.suggest(call(notes), signal);

    const [body, options] = create.mock.calls[0] as [Record<string, unknown>, { signal: AbortSignal }];
    expect(options.signal).toBe(signal);
    expect(body).toMatchObject({
      model: 'claude-test',
      system: SUGGESTION_SYSTEM_PROMPT,
      max_tokens: 2_000,
      tool_choice: { type: 'tool', name: 'suggest' },
    });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expectAllowed(messages[0]?.content ?? '', notes);
    expect(result).toEqual({ output: answer.content[0]?.input, inputTokens: 900, outputTokens: 40, truncated: false });
    expect(adapter.label).toBe('Anthropic (claude-test)');
  });

  it('reports an answer that stopped at the token limit as truncated', async () => {
    const create = jest.fn().mockResolvedValue({ ...answer, stop_reason: 'max_tokens' });
    const adapter = new AnthropicImportSuggestionsAdapter('m', 'k', { messages: { create } } as unknown as Pick<Anthropic, 'messages'>);
    await expect(adapter.suggest(call(false), new AbortController().signal)).resolves.toMatchObject({ truncated: true });
  });

  it('returns the text when the model answers without the tool', async () => {
    const create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'no idea' }], usage: undefined });
    const adapter = new AnthropicImportSuggestionsAdapter('m', 'k', { messages: { create } } as unknown as Pick<Anthropic, 'messages'>);
    await expect(adapter.suggest(call(false), new AbortController().signal)).resolves.toEqual({
      output: 'no idea',
      inputTokens: null,
      outputTokens: null,
      truncated: false,
    });
  });
});

describe('OpenAICompatibleImportSuggestionsAdapter (#1174)', () => {
  const completion = (content: string, finish_reason = 'stop') => ({
    choices: [{ message: { content }, finish_reason }],
    usage: { prompt_tokens: 800, completion_tokens: 30 },
  });
  const adapterWith = (create: jest.Mock) =>
    new OpenAICompatibleImportSuggestionsAdapter('qwen3:14b', 'http://localhost:11434/v1', undefined, {
      chat: { completions: { create } },
    } as unknown as Pick<OpenAI, 'chat'>);

  it.each([false, true])('sends only the allowed payload (notes %s) in JSON mode', async (notes) => {
    const create = jest.fn().mockResolvedValue(completion('{"suggestions":[]}'));
    const adapter = adapterWith(create);
    const signal = new AbortController().signal;

    const result = await adapter.suggest(call(notes), signal);

    const [body, options] = create.mock.calls[0] as [Record<string, unknown>, { signal: AbortSignal }];
    expect(options.signal).toBe(signal);
    expect(body).toMatchObject({ model: 'qwen3:14b', response_format: { type: 'json_object' }, max_tokens: 2_000 });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(SUGGESTION_SYSTEM_PROMPT);
    expectAllowed(messages[1]?.content ?? '', notes);
    expect(result).toEqual({ output: { suggestions: [] }, inputTokens: 800, outputTokens: 30, truncated: false });
    expect(adapter.label).toBe('qwen3:14b at localhost:11434');
  });

  it('reports an answer that stopped at the token limit as truncated', async () => {
    const adapter = adapterWith(jest.fn().mockResolvedValue(completion('{"suggestions": [{"ki', 'length')));
    await expect(adapter.suggest(call(false), new AbortController().signal)).resolves.toMatchObject({
      output: '{"suggestions": [{"ki',
      truncated: true,
    });
  });

  it('skips a reasoning block before the JSON', async () => {
    const adapter = adapterWith(jest.fn().mockResolvedValue(completion('<think>hmm</think>\n{"suggestions":[1]}')));
    await expect(adapter.suggest(call(false), new AbortController().signal)).resolves.toMatchObject({ output: { suggestions: [1] } });
  });

  it('returns the text when it is not JSON, for validation to drop', async () => {
    const adapter = adapterWith(jest.fn().mockResolvedValue(completion('Sure! Here are some ideas')));
    await expect(adapter.suggest(call(false), new AbortController().signal)).resolves.toMatchObject({
      output: 'Sure! Here are some ideas',
    });
  });
});

describe('buildImportSuggestionProvider (#1174)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['unset', {}],
    ['blank', { IMPORT_SUGGESTIONS_PROVIDER: ' ' }],
    ['set with no model', { IMPORT_SUGGESTIONS_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }],
    ['openai-compatible with no base URL', { IMPORT_SUGGESTIONS_PROVIDER: 'openai-compatible', IMPORT_SUGGESTIONS_MODEL: 'm' }],
    ['an unknown provider', { IMPORT_SUGGESTIONS_PROVIDER: 'gemini', IMPORT_SUGGESTIONS_MODEL: 'm' }],
    // The SDK would accept no key and fail every request, so suggestions would show as on.
    ['anthropic with no API key', { IMPORT_SUGGESTIONS_PROVIDER: 'anthropic', IMPORT_SUGGESTIONS_MODEL: 'm', ANTHROPIC_API_KEY: ' ' }],
  ])('is off when the provider is %s', (_label, env) => {
    expect(buildImportSuggestionProvider(env as NodeJS.ProcessEnv)).toBeNull();
  });

  it('builds the Anthropic adapter', () => {
    const provider = buildImportSuggestionProvider({
      IMPORT_SUGGESTIONS_PROVIDER: 'Anthropic',
      IMPORT_SUGGESTIONS_MODEL: 'claude-test',
      ANTHROPIC_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(AnthropicImportSuggestionsAdapter);
  });

  it('builds the OpenAI-compatible adapter', () => {
    const provider = buildImportSuggestionProvider({
      IMPORT_SUGGESTIONS_PROVIDER: 'openai-compatible',
      IMPORT_SUGGESTIONS_MODEL: 'qwen3:14b',
      IMPORT_SUGGESTIONS_BASE_URL: 'http://localhost:11434/v1',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(OpenAICompatibleImportSuggestionsAdapter);
    expect(provider?.label).toBe('qwen3:14b at localhost:11434');
  });

  // Every call would fail, so suggestions would show as on and always come back unavailable.
  it.each([
    ['has no host', 'ollama-box:11434'],
    ['has no host and credentials', 'user:secret@ollama-box:11434'],
    ['does not parse', 'not a url'],
    ['is not http', 'ftp://ollama-box/v1'],
    // Node's fetch refuses a URL with credentials, so the SDK would throw on every call.
    ['has credentials', 'https://user:secret@llm.example.com/v1'],
  ])('is off when the base URL %s', (_label, baseURL) => {
    expect(
      buildImportSuggestionProvider({
        IMPORT_SUGGESTIONS_PROVIDER: 'openai-compatible',
        IMPORT_SUGGESTIONS_MODEL: 'qwen3:14b',
        IMPORT_SUGGESTIONS_BASE_URL: baseURL,
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('names only the host, never the path', () => {
    const provider = buildImportSuggestionProvider({
      IMPORT_SUGGESTIONS_PROVIDER: 'openai-compatible',
      IMPORT_SUGGESTIONS_MODEL: 'qwen3:14b',
      IMPORT_SUGGESTIONS_BASE_URL: 'https://llm.example.com/v1',
    } as NodeJS.ProcessEnv);
    expect(provider?.label).toBe('qwen3:14b at llm.example.com');
  });
});
