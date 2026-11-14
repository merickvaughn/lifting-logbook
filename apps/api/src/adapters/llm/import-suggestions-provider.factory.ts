import { Logger, Provider } from '@nestjs/common';
import { IMPORT_SUGGESTION_PROVIDER } from '../../ports/tokens';
import type { IImportSuggestionProvider } from '../../ports/IImportSuggestionProvider';
import { AnthropicImportSuggestionsAdapter } from './anthropic-import-suggestions.adapter';
import { OpenAICompatibleImportSuggestionsAdapter } from './openai-compatible-import-suggestions.adapter';

const logger = new Logger('ImportSuggestionsProviderFactory');

/**
 * The import wizard's LLM suggestions provider (#1174, proposal decision 12), or null when
 * suggestions are off. Unlike the planning agent's factory there's no default: nothing is called
 * unless `IMPORT_SUGGESTIONS_PROVIDER` names a provider and its settings are complete, so a
 * half-set configuration turns suggestions off rather than sending history somewhere unintended.
 *
 * - `IMPORT_SUGGESTIONS_PROVIDER`: `anthropic` or `openai-compatible`.
 * - `IMPORT_SUGGESTIONS_MODEL`: required.
 * - `IMPORT_SUGGESTIONS_BASE_URL`: required for `openai-compatible`, such as Ollama's
 *   `http://localhost:11434/v1`.
 * - `IMPORT_SUGGESTIONS_API_KEY`: the provider's key; `anthropic` falls back to `ANTHROPIC_API_KEY`,
 *   and is off when neither is set.
 */
export function buildImportSuggestionProvider(env: NodeJS.ProcessEnv = process.env): IImportSuggestionProvider | null {
  const provider = (env.IMPORT_SUGGESTIONS_PROVIDER ?? '').trim().toLowerCase();
  if (provider === '') return null;
  const model = (env.IMPORT_SUGGESTIONS_MODEL ?? '').trim();
  if (model === '') {
    logger.warn('IMPORT_SUGGESTIONS_PROVIDER is set but IMPORT_SUGGESTIONS_MODEL is not, so import suggestions are off');
    return null;
  }
  const apiKey = env.IMPORT_SUGGESTIONS_API_KEY?.trim() || undefined;
  if (provider === 'anthropic') {
    // The SDK accepts a missing key until a request is sent, so check it here.
    const key = apiKey ?? (env.ANTHROPIC_API_KEY?.trim() || undefined);
    if (!key) {
      logger.warn('IMPORT_SUGGESTIONS_PROVIDER is anthropic but no API key is set, so import suggestions are off');
      return null;
    }
    logger.log(`Import suggestions use Anthropic (model ${model})`);
    return new AnthropicImportSuggestionsAdapter(model, key);
  }
  if (provider === 'openai-compatible') {
    const baseURL = (env.IMPORT_SUGGESTIONS_BASE_URL ?? '').trim();
    if (baseURL === '') {
      logger.warn('IMPORT_SUGGESTIONS_PROVIDER is openai-compatible but IMPORT_SUGGESTIONS_BASE_URL is not set, so import suggestions are off');
      return null;
    }
    const adapter = new OpenAICompatibleImportSuggestionsAdapter(model, baseURL, apiKey);
    logger.log(`Import suggestions use ${adapter.label}`);
    return adapter;
  }
  logger.warn(`IMPORT_SUGGESTIONS_PROVIDER "${provider}" isn't anthropic or openai-compatible, so import suggestions are off`);
  return null;
}

export const importSuggestionProvider: Provider = {
  provide: IMPORT_SUGGESTION_PROVIDER,
  useFactory: () => buildImportSuggestionProvider(),
};
