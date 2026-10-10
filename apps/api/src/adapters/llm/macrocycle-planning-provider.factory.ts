import { Logger, Provider } from '@nestjs/common';
import { MACROCYCLE_PLANNING_AGENT } from '../../ports/tokens';
import { IMacrocyclePlanningAgent } from '../../ports/IMacrocyclePlanningAgent';
import { AnthropicMacrocyclePlanningAdapter } from './anthropic-macrocycle-planning.adapter';
import { OpenAICompatibleMacrocyclePlanningAdapter } from './openai-compatible-macrocycle-planning.adapter';

const logger = new Logger('MacrocyclePlanningProviderFactory');

export function buildMacrocyclePlanningAgent(): IMacrocyclePlanningAgent {
  const provider = (process.env.MACROCYCLE_AGENT_PROVIDER ?? 'openai').toLowerCase();
  if (provider === 'anthropic') {
    logger.log('Using Anthropic macrocycle planning adapter');
    return new AnthropicMacrocyclePlanningAdapter();
  }
  logger.log(`Using OpenAI-compatible macrocycle planning adapter (provider="${provider}")`);
  return new OpenAICompatibleMacrocyclePlanningAdapter();
}

export const macrocyclePlanningAgentProvider: Provider = {
  provide: MACROCYCLE_PLANNING_AGENT,
  useFactory: () => buildMacrocyclePlanningAgent(),
};
