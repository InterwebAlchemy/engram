import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  DreamsCompletionResult,
  DreamsMessage,
  DreamsProvider,
  DreamsProviderConfig,
} from './types.js';

const DEFAULT_MAX_TOKENS = 16000;

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
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: messages.map<ChatCompletionMessageParam>((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    const { usage } = response;

    return {
      content: response.choices[0]?.message?.content?.trim() ?? '',
      usage:
        usage === undefined
          ? undefined
          : {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            },
    };
  }
}
