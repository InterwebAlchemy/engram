/**
 * Section-marker utilities for injecting, updating, and stripping
 * delimited blocks in markdown files (e.g. ~/.claude/CLAUDE.md).
 *
 * Markers use HTML comments so they're invisible in rendered markdown:
 *   <!-- engram:start -->
 *   ...bootstrap content...
 *   <!-- engram:end -->
 */

const MARKER_START = '<!-- engram:start -->';
const MARKER_END = '<!-- engram:end -->';

/** Regex that matches the full marked block including markers and surrounding blank lines. */
const MARKED_BLOCK_PATTERN = /\n*<!-- engram:start -->\n[\s\S]*?<!-- engram:end -->\n*/u;

export type Placement = 'top' | 'bottom';

/** Returns true if the content contains an Engram marked block. */
export function hasMarkedBlock(content: string): boolean {
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

/** Wraps body text in start/end markers. */
export function wrapInMarkers(body: string): string {
  return `${MARKER_START}\n${body.trim()}\n${MARKER_END}`;
}

/**
 * Injects or updates an Engram marked block in a file's content.
 *
 * - If markers already exist: replaces the content between them (idempotent update).
 * - If no markers exist and `existing` has content: inserts at `placement` with a blank line separator.
 * - If no markers exist and `existing` is empty: returns just the marked block.
 */
export function injectMarkedBlock(
  existing: string,
  body: string,
  placement: Placement,
): string {
  const block = wrapInMarkers(body);

  if (hasMarkedBlock(existing)) {
    return `${existing.replace(MARKED_BLOCK_PATTERN, `\n\n${block}\n`).trim()}\n`;
  }

  const trimmed = existing.trim();
  if (trimmed.length === 0) {
    return `${block}\n`;
  }

  return placement === 'top'
    ? `${block}\n\n${trimmed}\n`
    : `${trimmed}\n\n${block}\n`;
}

/**
 * Strips the Engram marked block from content.
 * Returns the cleaned content, or an empty string if nothing remains.
 */
export function stripMarkedBlock(content: string): string {
  if (!hasMarkedBlock(content)) return content;
  return `${content.replace(MARKED_BLOCK_PATTERN, '\n').replace(/^\n+|\n+$/gu, '').trim()}\n`;
}

/**
 * Extracts just the body between the markers (without the markers themselves).
 * Returns null if no marked block is found.
 */
export function extractMarkedBody(content: string): string | null {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  return content.slice(startIdx + MARKER_START.length, endIdx).trim();
}

/**
 * Returns true if the file content is *only* the Engram marked block
 * (i.e. we wrote the whole file and there's nothing else to preserve).
 */
export function isOnlyMarkedBlock(content: string): boolean {
  return stripMarkedBlock(content).trim().length === 0;
}
