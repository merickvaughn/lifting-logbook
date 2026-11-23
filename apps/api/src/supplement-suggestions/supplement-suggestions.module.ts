import { Module, Provider } from '@nestjs/common';
import { importSuggestionProvider } from '../adapters/llm/import-suggestions-provider.factory';
import { supplementSuggestionUsageProvider } from '../import-suggestions/import-suggestion-usage';
import { SUPPLEMENT_LABEL_LOOKUP } from '../ports/tokens';
import { DsldLabelLookup } from './dsld-label-lookup';
import { SupplementSuggestionsService } from './supplement-suggestions.service';

const labelLookupProvider: Provider = { provide: SUPPLEMENT_LABEL_LOOKUP, useFactory: () => new DsldLabelLookup() };

/** Tiers 2 and 3 of the supplement suggestions (#1381). The AI provider is the import suggestions' own. */
@Module({
  providers: [importSuggestionProvider, supplementSuggestionUsageProvider, labelLookupProvider, SupplementSuggestionsService],
  exports: [SupplementSuggestionsService],
})
export class SupplementSuggestionsModule {}
