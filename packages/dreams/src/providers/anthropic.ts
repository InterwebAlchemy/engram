import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type {
  DreamsCompletionResult,
  DreamsMessage,
  DreamsProvider,
  DreamsProviderConfig,
} from './types';

export class AnthropicProvider implements DreamsProvider {
  private readonly client: Anthropic;

  constructor(private readonly config: DreamsProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async complete(messages: DreamsMessage[]): Promise<DreamsCompletionResult> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const conversation = messages
      .filter((message) => message.role !== 'system')
      .map<MessageParam>((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));

    const response = await this.client.messages.create({
      model: this.config.model,
      system,
      temperature: 0,
      max_tokens: this.config.maxTokens ?? 16000,
      messages: conversation.length > 0
        ? conversation
        : [{ role: 'user', content: 'Return an empty JSON array.' }],
    });

    return {
      content: response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim(),
      usage: response.usage
        ? {
            prompt_tokens: response.usage.input_tokens ?? 0,
            completion_tokens: response.usage.output_tokens ?? 0,
            total_tokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }
}
