/**
 * The port for the import wizard's optional LLM suggestions (#1174, proposal decisions 11 and 12).
 *
 * One structured call per request, not the planning agent's tool loop. The adapter sends the
 * system prompt and the payload as given, and returns what the model produced, unvalidated: the
 * service validates every suggestion against the file's parsed rows. Nothing here may log the
 * payload or the response.
 */
export interface ImportSuggestionCall {
  /** Instructions, including the response format. Holds none of the lifter's data. */
  system: string;
  /** The JSON payload decision 11 allows, already stripped of free text the lifter didn't opt into. */
  payload: unknown;
  /** The most tokens the model may return. */
  maxOutputTokens: number;
}

export interface ImportSuggestionCallResult {
  /** The model's answer: parsed JSON, or the raw text when it wasn't JSON. */
  output: unknown;
  /** Token counts, when the provider reports them. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** The model stopped at `maxOutputTokens`, so `output` is cut off. */
  truncated: boolean;
}

export interface IImportSuggestionProvider {
  /** Who the lifter is told their sets go to, such as "Anthropic (claude-sonnet-4-6)". */
  readonly label: string;
  /** Short provider id for logs and spans: `anthropic` or `openai-compatible`. */
  readonly kind: string;
  /** Makes the one call. Rejects when `signal` aborts or the provider fails. */
  suggest(call: ImportSuggestionCall, signal: AbortSignal): Promise<ImportSuggestionCallResult>;
}

/**
 * The per-user hourly allowance of suggestion requests (decision 12), counted in
 * `import_suggestion_usage` so it holds across API instances.
 */
export interface IImportSuggestionUsage {
  /**
   * Records one request for `userId` at `now` if fewer than `limit` were made in the hour before
   * it. Returns whether it was recorded and, if not, when the oldest of them leaves the window.
   */
  tryConsume(userId: string, now: Date, limit: number): Promise<{ allowed: true } | { allowed: false; retryAt: Date }>;
}
