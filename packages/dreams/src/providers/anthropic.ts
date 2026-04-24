import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type {
  DreamsCompletionResult,
  DreamsMessage,
  DreamsProvider,
  DreamsProviderConfig,
} from './types.js';

const DEFAULT_MAX_TOKENS = 16000;
const EMPTY_JSON_RESPONSE = 'Return an empty JSON array.';

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
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: conversation.length > 0
        ? conversation
        : [{ role: 'user', content: EMPTY_JSON_RESPONSE }],
    });

    const { usage } = response;

    return {
      content: response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim(),
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
      },
    };
  }
}
