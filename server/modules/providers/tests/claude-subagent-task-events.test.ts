import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Claude reports a spawned agent twice: as the `Agent` tool call in the
 * transcript, and as a `system` task event on the live stream. Only the second
 * one can say whether a *backgrounded* agent is still running, because the
 * launch result of such an agent comes back the moment it is admitted — which
 * is what made a running agent render as finished.
 */

const SESSION_ID = 'claude-session-1';
const TASK_ID = 'task-a1b2c3';
const TOOL_USE_ID = 'toolu_agent_1';

/** Drives the provider's normalizer the way the live SDK stream does. */
function normalize(event: Record<string, unknown>) {
  return new ClaudeSessionsProvider().normalizeMessage(
    { uuid: 'evt-1', session_id: SESSION_ID, ...event },
    SESSION_ID,
  );
}

test('task_started opens a running subagent on the tool call that spawned it', () => {
  const [update] = normalize({
    type: 'system',
    subtype: 'task_started',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    description: 'Survey the repo',
    subagent_type: 'Explore',
  });

  assert.equal(update.kind, 'subagent_update');
  assert.equal(update.toolId, TOOL_USE_ID, 'the update must name the row it belongs to');
  assert.equal(update.subagent?.status, 'running');
  assert.equal(update.subagent?.id, TASK_ID);
  assert.equal(update.subagent?.toolUseId, TOOL_USE_ID);
  assert.equal(update.subagent?.type, 'Explore');
  assert.equal(update.subagent?.description, 'Survey the repo');
});

test('task_progress carries the agent running totals', () => {
  const [update] = normalize({
    type: 'system',
    subtype: 'task_progress',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    description: 'Survey the repo',
    subagent_type: 'Explore',
    usage: { total_tokens: 12_345, tool_uses: 4, duration_ms: 61_000 },
  });

  assert.equal(update.subagent?.status, 'running');
  assert.deepEqual(update.subagent?.usage, {
    totalTokens: 12_345,
    toolUses: 4,
    durationMs: 61_000,
  });
});

test('a task notification closes the agent with the status the provider reported', () => {
  const [completed] = normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'completed',
    summary: 'Agent finished',
  });
  assert.equal(completed.subagent?.status, 'completed');

  const [failed] = normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'failed',
    summary: 'Agent failed',
  });
  assert.equal(failed.subagent?.status, 'failed');
});

test('a cancelled agent reads as stopped rather than failed', () => {
  // Both are non-completions, and folding them together is what made an agent
  // the user deliberately cancelled render as a broken one.
  const [update] = normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'stopped',
    summary: 'Stopped by user',
  });

  assert.equal(update.subagent?.status, 'stopped');
});

test('a task event naming no tool call produces nothing', () => {
  // A backgrounded shell command is a task too, but the transcript has no card
  // for it — the Bash row is already the whole story there.
  assert.deepEqual(
    normalize({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-bash',
      description: 'npm run build',
    }),
    [],
  );
});

test('an unrecognized task status leaves the agent where it was', () => {
  assert.deepEqual(
    normalize({
      type: 'system',
      subtype: 'task_notification',
      task_id: TASK_ID,
      tool_use_id: TOOL_USE_ID,
      status: 'something-new',
    }),
    [],
  );
});

test('unrelated system events still normalize to nothing', () => {
  // The task branch sits ahead of the transcript branches, so it must not start
  // swallowing system events that belong to no agent.
  assert.deepEqual(
    normalize({ type: 'system', subtype: 'hook_started', hook_name: 'PostToolUse' }),
    [],
  );
});
