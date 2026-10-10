import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
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
  runPlan,
  toAnthropicTools,
} from './agent-tools';

const TOOLS = toAnthropicTools() as Anthropic.Messages.Tool[];

@Injectable()
export class AnthropicMacrocyclePlanningAdapter implements IMacrocyclePlanningAgent {
  private readonly logger = new Logger(AnthropicMacrocyclePlanningAdapter.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.model = process.env.MACROCYCLE_AGENT_MODEL ?? 'claude-sonnet-4-6';
    this.client = new Anthropic({ apiKey });
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
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: buildUserMessage(request) },
    ];

    return {
      runTurn: async (sig: AbortSignal): Promise<TurnOutcome> => {
        const response = await this.client.messages.create(
          {
            model: this.model,
            system: SYSTEM_PROMPT,
            messages,
            tools: TOOLS,
            max_tokens: 4096,
          },
          { signal: sig },
        );

        messages.push({ role: 'assistant', content: response.content });

        const toolUses = response.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
        );

        if (toolUses.length === 0) {
          const text = response.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          return { type: 'no_calls', text };
        }

        return {
          type: 'tool_calls',
          calls: toolUses.map((use) => ({
            id: use.id,
            name: use.name,
            args: (use.input ?? {}) as Record<string, unknown>,
          })),
        };
      },

      appendResults: (results) => {
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = results.map(
          ({ id, result }) => ({
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify(result),
            is_error: !result.ok,
          }),
        );
        messages.push({ role: 'user', content: toolResults });
      },
    };
  }
}
