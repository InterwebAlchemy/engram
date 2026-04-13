import type { VaultNote } from './vault';
import { tokenizeQuery, escapeRegex } from './utils';

export interface ScoredNote {
  note: VaultNote;
  score: number; // 0-1 normalized
}

/**
 * Pluggable search provider for ranking vault notes against a query.
 * Implementations handle their own thresholds and scoring logic.
 */
export interface SearchProvider {
  rank(query: string, notes: VaultNote[]): ScoredNote[];
}

// ─── Scoring weights ────────────────────────────────────────────────────────

const WEIGHT_SUMMARY = 0.4;
const WEIGHT_TAGS = 0.3;
const WEIGHT_CONTENT = 0.2;
const WEIGHT_RECENCY = 0.1;

const MIN_SCORE = 0.05;
const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const CONTENT_FALLBACK_LENGTH = 500;

// ─── KeywordSearchProvider ──────────────────────────────────────────────────

export class KeywordSearchProvider implements SearchProvider {
  rank(query: string, notes: VaultNote[]): ScoredNote[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const now = Date.now();
    const results: ScoredNote[] = [];

    for (const note of notes) {
      const summaryScore = scoreSummary(tokens, note);
      const tagScore = scoreTags(tokens, note);
      const contentScore = scoreContent(tokens, note);

      // Textual relevance must be non-zero — recency alone shouldn't surface a note
      const textualScore =
        summaryScore * WEIGHT_SUMMARY +
        tagScore * WEIGHT_TAGS +
        contentScore * WEIGHT_CONTENT;

      if (textualScore < MIN_SCORE) continue;

      const recencyBoost = scoreRecency(now, note);
      const score = textualScore + recencyBoost * WEIGHT_RECENCY;

      results.push({ note, score });
    }

    return results.sort((a, b) => b.score - a.score);
  }
}

// ─── Scoring functions ──────────────────────────────────────────────────────

function scoreSummary(tokens: string[], note: VaultNote): number {
  const summary = typeof note.frontmatter.summary === 'string'
    ? note.frontmatter.summary
    : note.content.slice(0, CONTENT_FALLBACK_LENGTH);

  if (!summary) return 0;

  const lower = summary.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (lower.includes(token)) matched += 1;
  }
  return matched / tokens.length;
}

function scoreTags(tokens: string[], note: VaultNote): number {
  const tags = Array.isArray(note.frontmatter.tags)
    ? note.frontmatter.tags
    : typeof note.frontmatter.tags === 'string'
      ? [note.frontmatter.tags]
      : [];

  if (tags.length === 0) return 0;

  // Split tags on / and - to get individual segments for matching
  const tagSegments = tags.flatMap((tag: string) =>
    String(tag).toLowerCase().split(/[/-]/).filter((s: string) => s.length > 2),
  );

  let matched = 0;
  for (const token of tokens) {
    if (tagSegments.some((seg: string) => seg.includes(token) || token.includes(seg))) {
      matched += 1;
    }
  }
  return Math.min(1.0, matched / tokens.length);
}

function scoreContent(tokens: string[], note: VaultNote): number {
  const content = note.content;
  if (!content) return 0;

  // Token coverage: what fraction of query tokens appear at least once in content
  const lower = content.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (lower.includes(token)) matched += 1;
  }
  return matched / tokens.length;
}

function scoreRecency(now: number, note: VaultNote): number {
  const updated = note.frontmatter.updated ?? note.frontmatter.created;
  if (typeof updated !== 'string') return 0;

  const age = now - new Date(updated).getTime();
  if (age <= 0) return 1.0;
  if (age >= RECENCY_WINDOW_MS) return 0;
  return 1.0 - age / RECENCY_WINDOW_MS;
}
