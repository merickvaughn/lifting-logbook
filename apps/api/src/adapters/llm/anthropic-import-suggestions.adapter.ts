import Anthropic from '@anthropic-ai/sdk';
import type {
  IImportSuggestionProvider,
  ImportSuggestionCall,
  ImportSuggestionCallResult,
} from '../../ports/IImportSuggestionProvider';
import { SUGGESTION_RESPONSE_SCHEMA } from '../../import-suggestions/suggestion-prompt';

const TOOL_NAME = 'suggest';

/**
 * Import suggestions from Anthropic (#1174): one Messages call, held to the response schema by a
 * forced tool call. No retries: the SDK's own are turned off, since decision 12 allows none.
 */
export class AnthropicImportSuggestionsAdapter implements IImportSuggestionProvider {
  readonly kind = 'anthropic';
  readonly label: string;
  private readonly client: Pick<Anthropic, 'messages'>;

  constructor(
    private readonly model: string,
    apiKey: string | undefined,
    client?: Pick<Anthropic, 'messages'>,
  ) {
    this.label = `Anthropic (${model})`;
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 0 });
  }

  async suggest(call: ImportSuggestionCall, signal: AbortSignal): Promise<ImportSuggestionCallResult> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        system: call.system,
        max_tokens: call.maxOutputTokens,
        messages: [{ role: 'user', content: JSON.stringify(call.payload) }],
        tools: [
          {
            name: TOOL_NAME,
            description: 'Return the suggestions for the lifter to review.',
            input_schema: SUGGESTION_RESPONSE_SCHEMA as unknown as Anthropic.Messages.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME },
      },
      { signal },
    );
    const use = response.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return {
      output: use ? use.input : text,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    };
  }
}
