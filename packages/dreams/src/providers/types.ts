export interface DreamsMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DreamsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface DreamsCompletionResult {
  content: string;
  usage?: DreamsUsage;
}

export interface DreamsProvider {
  complete(messages: DreamsMessage[]): Promise<DreamsCompletionResult>;
}

export interface DreamsProviderConfig {
  model: string;
  apiKey?: string;
  baseURL?: string;
}
