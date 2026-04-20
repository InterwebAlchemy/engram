import { encode } from 'gpt-tokenizer';

/**
 * Estimate the token count of a string using `gpt-tokenizer`.
 * Matches the baseline estimator used by `ContextBuilder` (no correction factor).
 */
export function estimateTokens(text: string): number {
  return encode(text).length;
}
