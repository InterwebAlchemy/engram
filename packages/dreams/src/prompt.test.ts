import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDreamNarrativeMessages, buildDreamsMessages, type DreamsEngramContext } from './prompt';
import type { DreamsReport } from './types';

const EMPTY_REPORT: DreamsReport = {
  timestamp: '2026-04-18T00:00:00.000Z',
  focusAreas: [],
  stateDistribution: { counts: {}, total: 0, memoriesByState: {} },
  threadCoverageGaps: [],
  threadHealth: {
    totalCount: 0,
    totalSizeBytes: 0,
    countsByStatus: {},
    threads: [],
    oversizedThreads: [],
    staleThreads: [],
  },
  mergeCandidates: [],
  dataQualityIssues: [],
  scratchHealth: { entryCount: 0, totalSizeBytes: 0, sessions: [], staleSessions: [] },
  scratchThreadCandidates: [],
};

test('buildDreamsMessages injects the current date anchor when provided', () => {
  const context: DreamsEngramContext = { currentDate: '2026-04-18' };
  const [systemMessage] = buildDreamsMessages(EMPTY_REPORT, [], context);

  assert.ok(typeof systemMessage.content === 'string');
  assert.match(systemMessage.content, /## Today\n\n2026-04-18/);
  assert.match(systemMessage.content, /Use absolute dates \(YYYY-MM-DD\)/);
});

test('buildDreamsMessages omits the date anchor when currentDate is missing', () => {
  const [systemMessage] = buildDreamsMessages(EMPTY_REPORT, []);

  assert.ok(typeof systemMessage.content === 'string');
  assert.doesNotMatch(systemMessage.content, /## Today/);
});

test('buildDreamNarrativeMessages includes the date but not the absolute-date guidance', () => {
  const context: DreamsEngramContext = { currentDate: '2026-04-18' };
  const [systemMessage] = buildDreamNarrativeMessages('[]', EMPTY_REPORT, context);

  assert.ok(typeof systemMessage.content === 'string');
  assert.match(systemMessage.content, /## Today\n\n2026-04-18/);
  assert.doesNotMatch(systemMessage.content, /Use absolute dates/);
});

test('buildDreamsMessages trims whitespace-only currentDate values', () => {
  const context: DreamsEngramContext = { currentDate: '   ' };
  const [systemMessage] = buildDreamsMessages(EMPTY_REPORT, [], context);

  assert.ok(typeof systemMessage.content === 'string');
  assert.doesNotMatch(systemMessage.content, /## Today/);
});
