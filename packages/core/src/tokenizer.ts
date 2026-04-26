import { decode, encode } from 'gpt-tokenizer';

/**
 * Estimate the token count of a string using `gpt-tokenizer`.
 * Matches the baseline estimator used by `ContextBuilder` (no correction factor).
 */
export function estimateTokens(text: string): number {
  return encode(text).length;
}

/**
 * Truncate `text` to at most `maxTokens` tokens. Returns the original string when
 * already within budget; otherwise returns a token-bounded prefix decoded back to text.
 * Callers that want an ellipsis or trimmed whitespace should add it on top.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return '';
  }

  const tokens = encode(text);
  if (tokens.length <= maxTokens) {
    return text;
  }

  return decode(tokens.slice(0, maxTokens));
}
