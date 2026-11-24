import { Module } from '@nestjs/common';
import { importSuggestionProvider } from './import-suggestions-provider.factory';

/**
 * The one instance of the LLM suggestions provider, shared by the import suggestions (#1174) and
 * the supplement suggestions (#1381), so its factory runs, and logs which provider it chose, once.
 */
@Module({
  providers: [importSuggestionProvider],
  exports: [importSuggestionProvider],
})
export class ImportSuggestionProviderModule {}
