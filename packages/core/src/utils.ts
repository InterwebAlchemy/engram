/**
 * Convert a string to a filesystem-safe slug.
 * Used for auto-naming memory notes from their content.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note';
}

/**
 * Format a Date as YYYY-MM-DD for use in directory paths.
 */
export function datePath(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Escape a string for safe use in a RegExp.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    .split(/[\s,;:.!?()\[\]{}"']+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}
