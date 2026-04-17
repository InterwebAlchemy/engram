import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDreamsResponse, protectCoreMemoryActions } from './runner';
import type { DreamsAction, DreamsReport } from './types';

test('parseDreamsResponse normalizes type and camelCase thread fields', () => {
  const response = parseDreamsResponse(JSON.stringify({
    actions: [
      {
        type: 'set_thread',
        path: 'engram/memory/facts/example.md',
        threadId: 'engram',
        reason: 'Scope the note to the active workstream.',
      },
    ],
  }));

  assert.deepEqual(response.actions, [
    {
      action: 'set_thread',
      path: 'engram/memory/facts/example.md',
      thread_id: 'engram',
      reason: 'Scope the note to the active workstream.',
    },
  ]);
});

test('parseDreamsResponse rejects malformed actions before execution', () => {
  assert.throws(
    () =>
      parseDreamsResponse(JSON.stringify({
        actions: [
          {
            path: 'engram/memory/facts/example.md',
            reason: 'Missing action name.',
          },
        ],
      })),
    /missing an action name/i,
  );
});

test('protectCoreMemoryActions converts core mutations into review flags', () => {
  const actions: DreamsAction[] = [
    {
      action: 'rewrite_content',
      path: 'engram/memory/soul.md',
      content: 'new body',
      summary: 'new summary',
      reason: 'Tighten the core note.',
    },
  ];

  const report: DreamsReport = {
    timestamp: '2026-04-10T00:00:00.000Z',
    focusAreas: [],
    stateDistribution: {
      counts: { core: 1 },
      total: 1,
      memoriesByState: {
        core: [
          {
            path: 'engram/memory/soul.md',
            updated: '2026-04-10T00:00:00.000Z',
            hasThread: false,
            hasSummary: true,
          },
        ],
      },
    },
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
    scratchHealth: {
      entryCount: 0,
      totalSizeBytes: 0,
      sessions: [],
      staleSessions: [],
    },
    scratchThreadCandidates: [],
  };

  assert.deepEqual(protectCoreMemoryActions(actions, report), [
    {
      action: 'flag_core_review',
      path: 'engram/memory/soul.md',
      concern: 'Core memory may need a manual update based on Dream analysis.',
      suggested_change: 'rewrite_content engram/memory/soul.md',
      reason: 'Tighten the core note.',
    },
  ]);
});
