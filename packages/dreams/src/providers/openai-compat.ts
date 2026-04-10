import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  DreamsCompletionResult,
  DreamsMessage,
  DreamsProvider,
  DreamsProviderConfig,
} from './types';

export class OpenAICompatProvider implements DreamsProvider {
  private readonly client: OpenAI;

  constructor(private readonly config: DreamsProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
    });
  }

  async complete(messages: DreamsMessage[]): Promise<DreamsCompletionResult> {
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: 0,
      max_tokens: 4000,
      messages: messages.map<ChatCompletionMessageParam>((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    return {
      content: response.choices[0]?.message?.content?.trim() ?? '',
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens ?? 0,
            completion_tokens: response.usage.completion_tokens ?? 0,
            total_tokens: response.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
}
