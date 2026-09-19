import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';

/**
 * While a subagent runs, its rows stream in stamped with the spawning Task's
 * tool id (`parentToolUseId`). They used to render as the session's own tool
 * calls, only to jump inside the subagent container after a refresh, when the
 * server ships the same timeline as `subagentTools` on the Task row.
 */

function message(
  id: string,
  overrides: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    timestamp: '2026-08-26T12:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: id,
    ...overrides,
  };
}

const taskRow = () => message('task', {
  kind: 'tool_use',
  toolId: 'task-1',
  toolName: 'Task',
  toolInput: { description: 'demo', prompt: 'do things' },
});

const subagentBash = (id: string, toolId: string) => message(id, {
  kind: 'tool_use',
  toolId,
  toolName: 'Bash',
  toolInput: { command: `echo ${id}` },
  parentToolUseId: 'task-1',
});

test('live subagent rows fold into the container instead of rendering top-level', () => {
  const converted = normalizedToChatMessages([
    taskRow(),
    subagentBash('step-1', 'bash-1'),
    message('note', { parentToolUseId: 'task-1', content: 'Running step 2' }),
    subagentBash('step-2', 'bash-2'),
    message('result-1', {
      kind: 'tool_result',
      toolId: 'bash-1',
      content: 'step 1 done',
      parentToolUseId: 'task-1',
    }),
  ]);

  assert.equal(converted.length, 1, 'subagent rows must not render as top-level messages');
  const container = converted[0];
  assert.equal(container.isSubagentContainer, true);

  const activity = container.subagentActivity ?? [];
  assert.deepEqual(
    activity.map((entry) => entry.kind),
    ['tool', 'text', 'tool'],
  );
  assert.equal(activity[0].toolName, 'Bash');
  assert.equal(activity[0].toolResult?.content, 'step 1 done');
  assert.equal(activity[2].toolResult, undefined, 'unfinished tool must stay pending');
});

test('the echoed task prompt does not appear in the timeline', () => {
  const converted = normalizedToChatMessages([
    taskRow(),
    message('echo', { role: 'user', content: 'do things', parentToolUseId: 'task-1' }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0].subagentActivity, undefined);
});

test('a growing live timeline invalidates the cached container projection', () => {
  const task = taskRow();
  const first = subagentBash('step-1', 'bash-1');

  const initial = normalizedToChatMessages([task, first]);
  assert.equal(initial[0].subagentActivity?.length, 1);

  const updated = normalizedToChatMessages([task, first, subagentBash('step-2', 'bash-2')]);
  assert.equal(
    updated[0].subagentActivity?.length,
    2,
    'the container must pick up rows that arrived after it was cached',
  );
});

/** A live task status for the agent spawned by {@link taskRow}. */
const taskStatus = (id: string, status: 'running' | 'completed' | 'stopped') => message(id, {
  kind: 'subagent_update',
  toolId: 'task-1',
  subagent: { id: 'agent-1', status, toolUseId: 'task-1' },
});

test('a live task status folds into the container instead of rendering a row', () => {
  const converted = normalizedToChatMessages([
    taskRow(),
    taskStatus('status-1', 'running'),
  ]);

  assert.equal(converted.length, 1, 'a status update is not a message the agent sent');
  assert.equal(converted[0].subagent?.status, 'running');
  assert.equal(converted[0].subagent?.toolUseId, 'task-1');
});

test('a live status outranks the status history attached to the same agent', () => {
  // A mid-run history reload ships the agent as finished because its transcript
  // is what the backend can read; the live stream is the only side that knows
  // it is still going, so it has to win.
  const fromHistory = message('task', {
    kind: 'tool_use',
    toolId: 'task-1',
    toolName: 'Agent',
    toolInput: {},
    subagent: { id: 'agent-1', type: 'Explore', status: 'completed', toolUseId: 'task-1' },
  });

  const converted = normalizedToChatMessages([fromHistory, taskStatus('status-1', 'running')]);

  assert.equal(converted[0].subagent?.status, 'running');
  assert.equal(converted[0].subagent?.type, 'Explore', 'identity still comes from history');
});

test('a status that arrives before any metadata still makes a container', () => {
  const converted = normalizedToChatMessages([taskRow(), taskStatus('status-1', 'stopped')]);

  assert.equal(converted[0].isSubagentContainer, true);
  assert.equal(converted[0].subagent?.status, 'stopped');
});

test('a moved status invalidates the cached container projection', () => {
  const task = taskRow();
  const running = taskStatus('status-1', 'running');

  const initial = normalizedToChatMessages([task, running]);
  assert.equal(initial[0].subagent?.status, 'running');

  const updated = normalizedToChatMessages([task, running, taskStatus('status-2', 'completed')]);
  assert.equal(
    updated[0].subagent?.status,
    'completed',
    'the container must pick up a status that arrived after it was cached',
  );
});

test('a stoppable agent stays stoppable when history loads behind it', () => {
  // Only the live side knows whether the runtime still holds a task handle for the
  // agent, and a history read never carries that. Dropping it in the merge would
  // take the stop control away from a running agent the moment a reload landed —
  // the one case the field exists for.
  const fromHistory = message('task', {
    kind: 'tool_use',
    toolId: 'task-1',
    toolName: 'Agent',
    toolInput: {},
    subagent: { id: 'agent-1', type: 'Explore', status: 'completed', toolUseId: 'task-1' },
  });
  const live = message('status-1', {
    kind: 'subagent_update',
    toolId: 'task-1',
    subagent: { id: 'agent-1', status: 'running', toolUseId: 'task-1', canInterrupt: true },
  });

  const converted = normalizedToChatMessages([fromHistory, live]);

  assert.equal(converted[0].subagent?.status, 'running');
  assert.equal(
    converted[0].subagent?.canInterrupt,
    true,
    'the stop control must survive a reload that lands mid-run',
  );
});

test('a status naming an agent with no container is dropped', () => {
  // Background shell commands are tasks too, but the transcript draws them as
  // the Bash call itself — there is no card for a status to attach to.
  const orphan = message('status-orphan', {
    kind: 'subagent_update',
    toolId: 'bash-9',
    subagent: { id: 'task-bash', status: 'completed', toolUseId: 'bash-9' },
  });

  const converted = normalizedToChatMessages([taskRow(), orphan]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0].subagent?.status, undefined);
});

test('the longer of the live and server timelines wins', () => {
  const serverTimeline = [
    { kind: 'tool' as const, toolId: 'bash-1', toolName: 'Bash' },
    { kind: 'tool' as const, toolId: 'bash-2', toolName: 'Bash' },
  ];
  const taskWithServerTimeline = message('task', {
    kind: 'tool_use',
    toolId: 'task-1',
    toolName: 'Task',
    toolInput: {},
    subagentTools: serverTimeline,
  });

  const stale = normalizedToChatMessages([
    taskWithServerTimeline,
    subagentBash('step-1', 'bash-1'),
  ]);
  assert.equal(stale[0].subagentActivity, serverTimeline);

  const fresher = normalizedToChatMessages([
    taskWithServerTimeline,
    subagentBash('step-1', 'bash-1'),
    subagentBash('step-2', 'bash-2'),
    subagentBash('step-3', 'bash-3'),
  ]);
  assert.equal(fresher[0].subagentActivity?.length, 3);
});
