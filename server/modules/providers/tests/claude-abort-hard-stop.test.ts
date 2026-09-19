import assert from 'node:assert/strict';
import test from 'node:test';

import {
  abortClaudeSDKSession,
  abortClaudeSubagent,
  isClaudeSDKSessionActive,
  registerActiveSessionForTests,
  trackRunningTasks,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

/**
 * `interrupt()` only ends the current turn. Anything that turn backgrounded — a
 * spawned agent, a backgrounded shell — keeps running until the CLI's own
 * post-turn ceiling expires, which this runtime sets to 30 minutes. So an abort
 * that stops at `interrupt()` tells the client the run is over while the work
 * carries on spending. These tests pin the hard stop that closes that gap, and the
 * per-task stop that reaches the backgrounded work before it.
 */

type AbortSpy = {
  controller: AbortController;
  interruptCalls: number;
  releaseCalls: number;
  /** Task ids the stop reached. */
  stopTaskIds: string[];
  /** Order of the stop's halves, so their sequencing can be pinned. */
  callOrder: string[];
  /** Everything written to the session's client. */
  sent: any[];
};

/** Installs a session record shaped like the one `addSession` stores. */
function installSession(
  sessionId: string,
  { withController = true, tasks = null, stopTask }: {
    withController?: boolean;
    tasks?: Map<string, string | null> | null;
    /** Overrides how the stop answers, for the paths that act on the answer. */
    stopTask?: (taskId: string) => Promise<void>;
  } = {},
): AbortSpy {
  const controller = new AbortController();
  const spy: AbortSpy = {
    controller,
    interruptCalls: 0,
    releaseCalls: 0,
    stopTaskIds: [],
    callOrder: [],
    sent: [],
  };

  registerActiveSessionForTests(sessionId, {
    instance: {
      interrupt: async () => {
        spy.interruptCalls += 1;
        spy.callOrder.push('interrupt');
      },
      stopTask: async (taskId: string) => {
        spy.stopTaskIds.push(taskId);
        spy.callOrder.push('stopTask');
        await stopTask?.(taskId);
      },
    },
    status: 'active',
    writer: { send: (data: unknown) => { spy.sent.push(data); } },
    startTime: Date.now(),
    releaseInput: () => {
      spy.releaseCalls += 1;
    },
    abortController: withController ? controller : null,
    runningTasks: tasks,
  });

  return spy;
}

test('aborting aborts the controller, which is what reaches the CLI process', async () => {
  const spy = installSession('abort-1');

  assert.equal(await abortClaudeSDKSession('abort-1'), true);
  assert.equal(
    spy.controller.signal.aborted,
    true,
    'the process must be terminated, not merely interrupted',
  );
  assert.equal(spy.releaseCalls, 1, 'the held stdin is released as a second exit path');
  assert.equal(isClaudeSDKSessionActive('abort-1'), false, 'the session entry is dropped');
});

test('the turn is asked to stop gracefully before the process is killed', async () => {
  // Interrupting first lets the CLI finish writing the turn it is abandoning;
  // killing straight away can leave that turn's last tool call without its
  // result row on disk.
  const spy = installSession('abort-2');

  await abortClaudeSDKSession('abort-2');

  assert.equal(spy.interruptCalls, 1);
  assert.equal(spy.controller.signal.aborted, true);
});

test('a slow graceful stop does not hold the hard stop up', async () => {
  // The bounded wait is the point: a runtime that stopped responding still gets
  // stopped. Without the bound this test would never reach its assertion.
  const controller = new AbortController();
  registerActiveSessionForTests('abort-3', {
    instance: { interrupt: () => new Promise(() => {}) },
    status: 'active',
    writer: null,
    startTime: Date.now(),
    releaseInput: () => {},
    abortController: controller,
  });

  const startedAt = Date.now();
  assert.equal(await abortClaudeSDKSession('abort-3'), true);
  assert.equal(controller.signal.aborted, true);
  assert.ok(Date.now() - startedAt < 10_000, 'the abort must not wait on a hung interrupt');
});

test('a rejecting graceful stop still hard-stops and does not report failure', async () => {
  // A rejected interrupt used to roll the abort flag back and report the abort
  // as failed, which left the run alive.
  const controller = new AbortController();
  registerActiveSessionForTests('abort-4', {
    instance: { interrupt: async () => { throw new Error('control channel closed'); } },
    status: 'active',
    writer: null,
    startTime: Date.now(),
    releaseInput: () => {},
    abortController: controller,
  });

  assert.equal(await abortClaudeSDKSession('abort-4'), true);
  assert.equal(controller.signal.aborted, true);
});

test('a session registered before the controller existed still interrupts the turn', async () => {
  const spy = installSession('abort-5', { withController: false });

  assert.equal(await abortClaudeSDKSession('abort-5'), true);
  assert.equal(spy.interruptCalls, 1, 'stopping the turn is all this session can do');
});

test('aborting a session that is not running reports failure', async () => {
  assert.equal(await abortClaudeSDKSession('never-started'), false);
});

test('aborting twice is a no-op the second time', async () => {
  const spy = installSession('abort-6');

  assert.equal(await abortClaudeSDKSession('abort-6'), true);
  assert.equal(await abortClaudeSDKSession('abort-6'), false);
  assert.equal(spy.controller.signal.aborted, true);
});

test('aborting stops every task the session still has running', async () => {
  const tasks = new Map<string, string | null>([
    ['task-a', 'tool-a'],
    ['task-b', 'tool-b'],
  ]);
  const spy = installSession('abort-7', { tasks });

  assert.equal(await abortClaudeSDKSession('abort-7', { subagentStopGraceMs: 0 }), true);

  assert.deepEqual(spy.stopTaskIds.slice().sort(), ['task-a', 'task-b']);
  assert.equal(
    spy.callOrder[0],
    'stopTask',
    'the tasks are stopped while the control channel is still open',
  );
  assert.equal(tasks.size, 0, 'the registry is drained so a second stop cannot re-ask');
});

test('each stopped task is reported, so the client stops drawing it as running', async () => {
  // The CLI's own `task_notification` cannot be relied on here: the process is
  // closed moments after the stop, and a card left reading `running` after the run
  // was stopped is the exact lie this path exists to remove.
  const spy = installSession('abort-8', { tasks: new Map([['task-a', 'tool-a']]) });

  await abortClaudeSDKSession('abort-8', { subagentStopGraceMs: 0 });

  const update = spy.sent.find((msg) => msg?.kind === 'subagent_update');
  assert.ok(update, 'the stop has to reach the client, not only the CLI');
  assert.equal(update.toolId, 'tool-a', 'it is folded into the card that spawned the task');
  assert.equal(update.subagent.status, 'stopped');
});

test('a task that never acknowledges the stop does not hold the abort up', async () => {
  const controller = new AbortController();
  registerActiveSessionForTests('abort-9', {
    instance: { interrupt: async () => {}, stopTask: () => new Promise(() => {}) },
    status: 'active',
    writer: null,
    startTime: Date.now(),
    releaseInput: () => {},
    abortController: controller,
    runningTasks: new Map([['task-a', 'tool-a']]),
  });

  const startedAt = Date.now();
  assert.equal(await abortClaudeSDKSession('abort-9', { subagentStopGraceMs: 0 }), true);
  assert.equal(controller.signal.aborted, true);
  assert.ok(Date.now() - startedAt < 10_000, 'a silent task must not block the stop');
});

test('a failing task stop still hard-stops the session', async () => {
  const controller = new AbortController();
  registerActiveSessionForTests('abort-10', {
    instance: {
      interrupt: async () => {},
      stopTask: async () => { throw new Error('control channel closed'); },
    },
    status: 'active',
    writer: null,
    startTime: Date.now(),
    releaseInput: () => {},
    abortController: controller,
    runningTasks: new Map([['task-a', 'tool-a']]),
  });

  assert.equal(await abortClaudeSDKSession('abort-10', { subagentStopGraceMs: 0 }), true);
  assert.equal(controller.signal.aborted, true);
});

test('a session registered with no controller still aborts, tasks and all', async () => {
  // Pre-controller sessions are the shape the earliest tests use; they must not
  // start throwing just because a task registry appeared.
  const spy = installSession('abort-11', {
    withController: false,
    tasks: new Map([['task-a', 'tool-a']]),
  });

  assert.equal(await abortClaudeSDKSession('abort-11', { subagentStopGraceMs: 0 }), true);
  assert.deepEqual(spy.stopTaskIds, ['task-a']);
  assert.equal(spy.interruptCalls, 1);
});

test('tasks are registered from the events that open and close them', () => {
  const running = new Map<string, string | null>();

  trackRunningTasks(running, {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-a',
    tool_use_id: 'tool-a',
  });
  assert.equal(running.get('task-a'), 'tool-a', 'the spawning tool call is kept for reporting');

  trackRunningTasks(running, { type: 'system', subtype: 'task_progress', task_id: 'task-a' });
  assert.equal(running.size, 1, 'progress carries no status and must not be read as one');

  trackRunningTasks(running, {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-a',
    status: 'completed',
  });
  assert.equal(running.size, 0, 'a settled task is no longer something to stop');
});

test('a task killed by a patch leaves the registry too', () => {
  // `task_updated` is the only one of the four that reports a status without also
  // reporting a tool call, so it must be able to remove a task but never add one.
  const running = new Map<string, string | null>([['task-a', 'tool-a']]);

  trackRunningTasks(running, {
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-a',
    patch: { status: 'killed' },
  });

  assert.equal(running.size, 0);
});

test('an unrecognised status does not remove a task that is still running', () => {
  const running = new Map<string, string | null>([['task-a', 'tool-a']]);

  trackRunningTasks(running, {
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-a',
    patch: { status: 'some-future-state' },
  });

  assert.equal(running.size, 1, 'a status this build cannot read is not a terminal one');
});

test('one subagent can be stopped by the tool call that spawned it', async () => {
  const tasks = new Map<string, string | null>([
    ['task-a', 'tool-a'],
    ['task-b', 'tool-b'],
  ]);
  const spy = installSession('sub-1', { tasks });

  assert.equal(await abortClaudeSubagent('sub-1', 'tool-b'), true);

  assert.deepEqual(spy.stopTaskIds, ['task-b'], 'only the agent that was asked for');
  assert.deepEqual(Array.from(tasks.keys()), ['task-a'], 'the other one is left running');
  const update = spy.sent.find((msg) => msg?.kind === 'subagent_update');
  assert.equal(update?.subagent.status, 'stopped', 'the client is told, so the row updates itself');
  assert.equal(update?.subagent.canInterrupt, undefined, 'a stopped agent is no longer stoppable');
});

test('an agent that is not tracked cannot be stopped, and nothing is claimed', async () => {
  // Claiming it stopped would be worse than a failed click: the agent would read as
  // stopped while it carried on working.
  const spy = installSession('sub-2', { tasks: new Map([['task-a', 'tool-a']]) });

  assert.equal(await abortClaudeSubagent('sub-2', 'tool-nope'), false);
  assert.deepEqual(spy.stopTaskIds, []);
  assert.deepEqual(spy.sent, [], 'a stop that did not happen is not reported');
});

test('a session with no spawned tasks cannot stop one', async () => {
  const spy = installSession('sub-3');

  assert.equal(await abortClaudeSubagent('sub-3', 'tool-a'), false);
  assert.deepEqual(spy.stopTaskIds, []);
});

test('a refused stop leaves the agent reachable for a second attempt', async () => {
  const tasks = new Map<string, string | null>([['task-a', 'tool-a']]);
  let attempts = 0;
  installSession('sub-4', {
    tasks,
    stopTask: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('control channel closed');
      }
    },
  });

  assert.equal(await abortClaudeSubagent('sub-4', 'tool-a'), false, 'the refusal is reported');
  assert.equal(tasks.size, 1, 'a task that is still running has to stay addressable');

  assert.equal(await abortClaudeSubagent('sub-4', 'tool-a'), true);
  assert.equal(tasks.size, 0);
});

test('a stop the CLI never acknowledges fails instead of hanging the click', async () => {
  const spy = installSession('sub-5', {
    tasks: new Map([['task-a', 'tool-a']]),
    stopTask: () => new Promise(() => {}),
  });

  const startedAt = Date.now();
  assert.equal(await abortClaudeSubagent('sub-5', 'tool-a'), false);
  assert.ok(Date.now() - startedAt < 5_000, 'a silent CLI must still resolve the request');
  assert.deepEqual(spy.sent, []);
});

test('a tool call belonging to another session cannot stop this one', async () => {
  // The lookup is the session's own registry, and that is the whole of the scoping:
  // an id from somewhere else simply is not in it.
  const tasks = new Map<string, string | null>([['task-a', 'tool-a']]);
  const spy = installSession('sub-6', { tasks });

  assert.equal(await abortClaudeSubagent('sub-6', 'tool-of-another-session'), false);
  assert.deepEqual(spy.stopTaskIds, []);
  assert.equal(tasks.size, 1);
});

test('stopping one subagent does not disturb the run it belongs to', async () => {
  // The point of the control: the agent goes, the turn it came from keeps its
  // process, its stdin and its session entry.
  const spy = installSession('sub-7', { tasks: new Map([['task-a', 'tool-a']]) });

  assert.equal(await abortClaudeSubagent('sub-7', 'tool-a'), true);

  assert.equal(spy.interruptCalls, 0, 'the turn is not interrupted');
  assert.equal(spy.releaseCalls, 0, 'the held stdin is not dropped');
  assert.equal(spy.controller.signal.aborted, false, 'the process is not closed');
  assert.equal(isClaudeSDKSessionActive('sub-7'), true, 'the session stays active');
});

test('a task that ends inside the grace is left to report itself', async () => {
  // The CLI announces a stopped task with its own `task_notification`, and that is also
  // what takes it out of the registry. Reporting it again from here would say the same
  // thing twice, and the second copy is the one that could be wrong.
  const tasks = new Map<string, string | null>([['task-a', 'tool-a']]);
  const spy = installSession('grace-1', {
    tasks,
    stopTask: async () => {
      // Stands in for that notification landing in the run loop a moment later.
      setTimeout(() => tasks.delete('task-a'), 50);
    },
  });

  const startedAt = Date.now();
  assert.equal(await abortClaudeSDKSession('grace-1', { subagentStopGraceMs: 5_000 }), true);

  assert.equal(tasks.size, 0);
  assert.deepEqual(spy.sent, [], 'the task reported itself, so nothing is said twice');
  assert.ok(
    Date.now() - startedAt < 2_000,
    'the wait ends when the task does, not when the grace does',
  );
});

test('a task that ignores the signal is waited out and then accounted for', async () => {
  // An agent that never answers must not hold the stop up, and must not vanish from the
  // client's view either: the process close is what stops it, and this is the last side
  // left that can say so.
  const tasks = new Map<string, string | null>([['task-a', 'tool-a']]);
  const spy = installSession('grace-2', { tasks, stopTask: async () => {} });

  const startedAt = Date.now();
  assert.equal(await abortClaudeSDKSession('grace-2', { subagentStopGraceMs: 300 }), true);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 250, 'the task is given its grace before the process goes');
  assert.ok(elapsed < 3_000, 'and no longer than that grace');
  assert.equal(tasks.size, 0, 'what is left over is accounted for rather than forgotten');
  const update = spy.sent.find((msg) => msg?.kind === 'subagent_update');
  assert.equal(update?.subagent.status, 'stopped');
});

test('the turn ends at once and the grace is waited out behind it', async () => {
  // The turn is what the user is watching, so it has to stop the moment the control is
  // pressed. Waiting on the agents first would leave it streaming for the whole grace
  // after the user asked for it to stop.
  const controller = new AbortController();
  const startedAt = Date.now();
  let interruptedAt = 0;

  registerActiveSessionForTests('grace-3', {
    instance: {
      interrupt: async () => { interruptedAt = Date.now(); },
      stopTask: async () => {},
    },
    status: 'active',
    writer: null,
    startTime: Date.now(),
    releaseInput: () => {},
    abortController: controller,
    runningTasks: new Map([['task-a', 'tool-a']]),
  });

  assert.equal(await abortClaudeSDKSession('grace-3', { subagentStopGraceMs: 400 }), true);

  assert.ok(interruptedAt - startedAt < 150, 'the turn ends as soon as stop is pressed');
  assert.ok(Date.now() - startedAt >= 350, 'the grace is still waited out after it');
  assert.equal(controller.signal.aborted, true);
});
