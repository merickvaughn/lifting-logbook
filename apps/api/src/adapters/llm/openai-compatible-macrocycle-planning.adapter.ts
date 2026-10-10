import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  MacrocyclePlanRequest,
  MacrocyclePlanResult,
  IMacrocyclePlanningAgent,
  WithRlsContext,
} from '../../ports/IMacrocyclePlanningAgent';
import {
  AgentLoopCallbacks,
  SYSTEM_PROMPT,
  TurnOutcome,
  buildUserMessage,
  isProposeTool,
  runPlan,
  toOpenAITools,
} from './agent-tools';

const TOOLS = toOpenAITools() as OpenAI.Chat.Completions.ChatCompletionTool[];

@Injectable()
export class OpenAICompatibleMacrocyclePlanningAdapter implements IMacrocyclePlanningAgent {
  private readonly logger = new Logger(OpenAICompatibleMacrocyclePlanningAdapter.name);
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const baseURL = process.env.MACROCYCLE_AGENT_BASE_URL ?? 'http://localhost:11434/v1';
    const apiKey = process.env.MACROCYCLE_AGENT_API_KEY ?? 'ollama';
    this.model = process.env.MACROCYCLE_AGENT_MODEL ?? 'llama3.1';

    if (!process.env.MACROCYCLE_AGENT_BASE_URL) {
      this.logger.warn(
        'MACROCYCLE_AGENT_BASE_URL is not set — defaulting to http://localhost:11434/v1 (Ollama dev mode)',
      );
    }

    this.client = new OpenAI({ baseURL, apiKey });
  }

  async plan(
    request: MacrocyclePlanRequest,
    withContext: WithRlsContext,
  ): Promise<MacrocyclePlanResult> {
    return runPlan(
      () => this.makeCallbacks(request),
      withContext,
      request,
      { log: (m) => this.logger.log(m), warn: (m) => this.logger.warn(m) },
    );
  }

  private makeCallbacks(request: MacrocyclePlanRequest): AgentLoopCallbacks {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(request) },
    ];

    return {
      runTurn: async (sig: AbortSignal): Promise<TurnOutcome> => {
        const completion = await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            tools: TOOLS,
            tool_choice: 'auto',
            max_tokens: 4096,
          },
          { signal: sig },
        );

        const choice = completion.choices[0];
        if (!choice) return { type: 'no_calls', text: 'Agent returned no choices.' };

        const msg = choice.message;
        messages.push(msg);

        const rawCalls = msg.tool_calls ?? [];
        if (rawCalls.length === 0) {
          return { type: 'no_calls', text: msg.content ?? '' };
        }

        const calls: TurnOutcome = { type: 'tool_calls', calls: [] };
        for (const tc of rawCalls) {
          if (tc.type !== 'function') continue;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // Malformed args on propose_macrocycle_plan: surface as no_calls so the
            // loop returns partial rather than substituting an empty proposal.
            if (isProposeTool(tc.function.name)) {
              return {
                type: 'no_calls',
                text: 'Failed to parse propose_macrocycle_plan arguments.',
              };
            }
          }
          if (calls.type === 'tool_calls') {
            calls.calls.push({ id: tc.id, name: tc.function.name, args });
          }
        }

        if (calls.type === 'tool_calls' && calls.calls.length === 0) {
          return { type: 'no_calls', text: msg.content ?? '' };
        }

        return calls;
      },

      appendResults: (results) => {
        for (const { id, result } of results) {
          messages.push({
            role: 'tool',
            tool_call_id: id,
            content: JSON.stringify(result),
          });
        }
      },
    };
  }
}
