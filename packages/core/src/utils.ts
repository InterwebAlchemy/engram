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
