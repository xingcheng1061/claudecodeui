import assert from 'node:assert/strict';

import { test } from 'vitest';

import { resolveSubagentStatus } from '@/modules/chat/subagents/subagentStatus';

/**
 * A card has two possible sources for an agent's state: the provider's own task
 * status, and an inference from whether the spawning call has resolved. The
 * inference is only ever a fallback, and the one thing it must not do is read a
 * launch acknowledgement as an answer — that is what made a still-running
 * background agent render as finished.
 */

test('the provider-reported status wins over any inference', () => {
  assert.equal(resolveSubagentStatus('running', { toolUseResult: { isAsync: true } }), 'running');
  assert.equal(resolveSubagentStatus('stopped', null), 'stopped');
  assert.equal(resolveSubagentStatus('failed', { content: 'irrelevant' }), 'failed');
});

test('an async launch acknowledgement leaves the agent running', () => {
  // The result exists, but it says "launched", not "finished".
  assert.equal(
    resolveSubagentStatus(undefined, { toolUseResult: { isAsync: true } }),
    'running',
  );
});

test('a resolved non-async call completes the agent', () => {
  assert.equal(resolveSubagentStatus(undefined, { content: '{"answer":42}' }), 'completed');
});

test('an agent with no result yet is running', () => {
  assert.equal(resolveSubagentStatus(undefined, null), 'running');
  assert.equal(resolveSubagentStatus(undefined, undefined), 'running');
});
