import assert from 'node:assert/strict';

import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * Claude reports a spawned agent twice: as the `Agent` tool call in the
 * transcript, and as a `system` task event on the live stream. Only the second
 * one can say whether a *backgrounded* agent is still running, because the
 * launch result of such an agent comes back the moment it is admitted — which
 * is what made a running agent render as finished.
 *
 * The four task subtypes normalize to one `task_status` kind; the client folds
 * them onto the card that launched the task (see `foldTaskStatus`).
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

test('task_started opens a running task on the tool call that spawned it', () => {
  const [update] = normalize({
    type: 'system',
    subtype: 'task_started',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    description: 'Survey the repo',
    task_type: 'local_workflow',
  });

  assert.equal(update.kind, 'task_status');
  assert.equal(update.event, 'started');
  assert.equal(update.taskId, TASK_ID);
  assert.equal(update.toolUseId, TOOL_USE_ID, 'the event must name the row it belongs to');
  assert.equal(update.taskType, 'local_workflow');
  assert.equal(update.description, 'Survey the repo');
  // No status yet: the fold marks a started task running.
  assert.equal(update.status, undefined);
});

test('task_progress carries the agent running totals', () => {
  const [update] = normalize({
    type: 'system',
    subtype: 'task_progress',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    description: 'Survey the repo',
    usage: { total_tokens: 12_345, tool_uses: 4, duration_ms: 61_000 },
  });

  assert.equal(update.kind, 'task_status');
  assert.equal(update.event, 'progress');
  assert.deepEqual(update.usage, {
    totalTokens: 12_345,
    toolUses: 4,
    durationMs: 61_000,
  });
});

test('a task notification closes the task with the status the provider reported', () => {
  const [completed] = normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'completed',
    summary: 'Agent finished',
  });
  assert.equal(completed.kind, 'task_status');
  assert.equal(completed.event, 'notification');
  assert.equal(completed.status, 'completed');

  const [failed] = normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'failed',
    summary: 'Agent failed',
  });
  assert.equal(failed.status, 'failed');
});

test('a cancelled task reads as stopped rather than failed', () => {
  // Both are non-completions, and folding them together is what made a task
  // the user deliberately cancelled render as a broken one.
  const [update] = normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'stopped',
    summary: 'Stopped by user',
  });

  assert.equal(update.status, 'stopped');
});

test('a task event naming no tool call still normalizes, without a row to land on', () => {
  // A backgrounded shell command is a task too, but the transcript has no card
  // for it — the Bash row is already the whole story there. The frame is
  // emitted and the client's fold drops it: an ambient task has no card.
  const [update] = normalize({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-bash',
    description: 'npm run build',
  });

  assert.equal(update.kind, 'task_status');
  assert.equal(update.toolUseId, undefined);
});

test('an unrecognized task status passes through for the fold to settle', () => {
  // The normalizer no longer filters statuses: the fold keeps a task where it
  // was until a recognized terminal word arrives, so an unknown one must not
  // be read as an outcome here.
  const [update] = normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'something-new',
  });

  assert.equal(update.kind, 'task_status');
  assert.equal(update.status, 'something-new');
});

test('unrelated system events still normalize to nothing', () => {
  // The task branch sits ahead of the transcript branches, so it must not start
  // swallowing system events that belong to no agent.
  assert.deepEqual(
    normalize({ type: 'system', subtype: 'hook_started', hook_name: 'PostToolUse' }),
    [],
  );
});
