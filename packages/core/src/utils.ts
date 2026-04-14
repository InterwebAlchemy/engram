const DEFAULT_SLUG = 'note';
const MAX_SLUG_LENGTH = 80;
const DATE_PATH_LENGTH = 10;
const MIN_QUERY_TOKEN_LENGTH = 2;

/**
 * Convert a string to a filesystem-safe slug.
 * Used for auto-naming memory notes from their content.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s\-]/gv, '')
    .replace(/[\s_]+/gv, '-')
    .replace(/^-+|-+$/gv, '')
    .slice(0, MAX_SLUG_LENGTH);

  return slug.length > 0 ? slug : DEFAULT_SLUG;
}

/**
 * Format a Date as YYYY-MM-DD for use in directory paths.
 */
export function datePath(date: Date = new Date()): string {
  return date.toISOString().slice(0, DATE_PATH_LENGTH);
}

/**
 * Escape a string for safe use in a RegExp.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^$\{\}\(\)\|\[\]\\]/gv, '\\$&');
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'from', 'they', 'their', 'what',
  'when', 'which', 'who', 'how', 'its', 'our', 'you', 'your', 'can',
  'will', 'all', 'also', 'into', 'more', 'than', 'just',
]);

/**
 * Tokenize a search query into meaningful terms.
 * Splits on whitespace/punctuation, drops stop words and short tokens.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;:.!?\(\)\[\]\{\}"']+/gv)
    .map((token) => token.trim())
    .filter((token) => token.length > MIN_QUERY_TOKEN_LENGTH && !STOP_WORDS.has(token));
}
