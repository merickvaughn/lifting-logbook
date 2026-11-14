import OpenAI from 'openai';
import type {
  IImportSuggestionProvider,
  ImportSuggestionCall,
  ImportSuggestionCallResult,
} from '../../ports/IImportSuggestionProvider';

/**
 * Import suggestions from an OpenAI-compatible server, such as local Ollama (#1174): one chat
 * completion in JSON mode. Ollama's compatibility layer confirms JSON mode but not `json_schema`,
 * so the schema is described in the prompt and the service validates whatever comes back. No
 * retries: the SDK's own are turned off, since decision 12 allows none.
 */
export class OpenAICompatibleImportSuggestionsAdapter implements IImportSuggestionProvider {
  readonly kind = 'openai-compatible';
  readonly label: string;
  private readonly client: Pick<OpenAI, 'chat'>;

  constructor(
    private readonly model: string,
    baseURL: string,
    apiKey: string | undefined,
    client?: Pick<OpenAI, 'chat'>,
  ) {
    this.label = `${model} at ${hostOf(baseURL)}`;
    // The SDK refuses to start without a key; a local server ignores it.
    this.client = client ?? new OpenAI({ baseURL, apiKey: apiKey ?? 'unused', maxRetries: 0 });
  }

  async suggest(call: ImportSuggestionCall, signal: AbortSignal): Promise<ImportSuggestionCallResult> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: 'system', content: call.system },
          { role: 'user', content: JSON.stringify(call.payload) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: call.maxOutputTokens,
      },
      { signal },
    );
    const content = completion.choices[0]?.message?.content ?? '';
    return {
      output: parseJson(content),
      inputTokens: completion.usage?.prompt_tokens ?? null,
      outputTokens: completion.usage?.completion_tokens ?? null,
    };
  }
}

/** The JSON a model returned, after any reasoning block before it; the text itself when it isn't JSON. */
function parseJson(content: string): unknown {
  const text = content.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}
