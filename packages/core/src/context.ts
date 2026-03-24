import { encode } from 'gpt-tokenizer';
import type { ContextSection } from './types';

interface SectionEntry extends ContextSection {
  estimatedTokens: number;
}

export class ContextBuilder {
  private sections: SectionEntry[] = [];

  constructor(public correctionFactor: number = 1.0) {}

  estimateTokens(text: string): number {
    return Math.ceil(encode(text).length * this.correctionFactor);
  }

  /**
   * Update the correction factor from actual API usage data.
   * Uses an exponential moving average to smooth per-request variance.
   */
  calibrate(estimated: number, actual: number): void {
    if (estimated === 0) return;
    const ratio = actual / estimated;
    this.correctionFactor = this.correctionFactor * 0.8 + ratio * 0.2;
  }

  /**
   * Add a section. Higher priority = kept when budget is tight.
   * Sections with the same label are deduplicated (last write wins).
   */
  addSection(label: string, content: string, priority: number): void {
    const existing = this.sections.findIndex((s) => s.label === label);
    const entry: SectionEntry = {
      label,
      content,
      priority,
      estimatedTokens: this.estimateTokens(content),
    };
    if (existing !== -1) {
      this.sections[existing] = entry;
    } else {
      this.sections.push(entry);
    }
  }

  clear(): void {
    this.sections = [];
  }

  /**
   * Build the final prompt string, dropping lowest-priority sections first
   * until the result fits within maxTokens.
   *
   * Sections are assembled in descending priority order (most important first),
   * which is conventional for system-prompt construction.
   */
  build(maxTokens: number): string {
    const sorted = [...this.sections].sort((a, b) => b.priority - a.priority);

    const included: SectionEntry[] = [];
    let used = 0;

    for (const section of sorted) {
      if (used + section.estimatedTokens <= maxTokens) {
        included.push(section);
        used += section.estimatedTokens;
      }
      // Low-priority sections that don't fit are silently dropped
    }

    return included.map((s) => s.content).join('\n\n');
  }

  /** Total estimated tokens for currently-held sections. */
  get estimatedTotal(): number {
    return this.sections.reduce((sum, s) => sum + s.estimatedTokens, 0);
  }
}
