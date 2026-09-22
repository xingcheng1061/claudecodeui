/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  learnContextWindowsFromResult,
  resolveContextWindow
} from '@/modules/providers/shared/context-window.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// How long an aborted turn is given to stop gracefully before its process is
// killed. `interrupt()` lets the CLI finish writing the turn it is abandoning —
// skipping it can leave the turn's last tool call without its result row on
// disk. It must never be able to hold the abort up, so the wait is bounded: a
// runtime that stopped responding still gets stopped.
const INTERRUPT_GRACE_MS = 3_000;

// How long a session's running tasks are given to acknowledge a stop before the
// process is closed out from under them. `stop_task` is a single control message,
// so this only ever covers a CLI that has stopped reading its own channel — and a
// CLI in that state is about to lose the process regardless.
const TASK_STOP_GRACE_MS = 1_500;

// How long a session's spawned tasks are given to end on their own after being asked
// to stop, before the process they run in is closed out from under them.
//
// `stop_task` is a request, not a kill: the task decides when it is done and says so
// with a `task_notification`. Closing the process before that notification arrives is
// what cut agents off mid-step. This is the window in which they get to reach a
// stopping point instead.
//
// It is a real trade, and it is also exactly how much slower "stop" feels, because the
// process cannot be closed until the wait is over. Ten seconds is long enough for an
// agent to wind down and short enough that the control still reads as a control. A task
// that does not finish in here is stopped anyway — the close that follows takes it.
// Override per call, or for a whole deployment with this env var.
const SUBAGENT_STOP_GRACE_MS = (() => {
  const configured = Number(process.env.CLAUDE_SUBAGENT_STOP_GRACE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 10_000;
})();

// How often the wait above re-checks whether the tasks it is waiting on have ended.
// They announce it by landing in the run loop, so this is a poll of a map that is
// already being maintained rather than a subscription of its own.
const TASK_SETTLE_POLL_MS = 200;

// Whether to ask the CLI to emit a turn as it is written, instead of only once each
// block is complete.
//
// Reasoning is what this is really for. Without it a thinking model emits nothing at
// all for the length of its reasoning — the completed block is the first anyone hears
// of it — so the client can only show a spinner while the most interesting part of the
// turn happens. With it, both the answer and the reasoning arrive incrementally.
//
// It changes what the CLI puts on the wire, so it can be switched off (set this to
// `0`) if a stream ever has to be quiet — for bandwidth, or if a CLI build turns out
// to double-report completed blocks alongside the increments.
const INCLUDE_PARTIAL_MESSAGES = process.env.CLAUDE_INCLUDE_PARTIAL_MESSAGES !== '0';

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn supersedes the previous hold. This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on every message, so it measures silence, not total time.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Forward the subagent conversation itself (its text and thinking), not just
  // the tool_use/tool_result heartbeat. The client folds these rows into the
  // agent's card — the transcript read after a refresh has them, so without
  // this the live card showed only tool calls and changed shape depending on
  // whether you were watching it happen or reading it afterwards.
  sdkOptions.forwardSubagentText = true;

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {AbortController} abortController - Cancels the run, process included
 * @param {Map} runningTasks - Tasks this run spawned and has not seen settle
 */
function addSession(sessionId, queryInstance, writer = null, releaseInput = null, abortController = null, runningTasks = null) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    // The abandoned run is left behind for real: interrupting only ends its
    // current turn, so whatever that turn backgrounded would otherwise keep
    // running — and spending — for the rest of the ceiling.
    //
    // The tasks are asked to stop first, because the abort below closes the very
    // channel that request travels over. It is not awaited: this path must not
    // delay the run that is replacing it, and the requests are dispatched
    // synchronously before the first await inside. Its tasks have no other owner
    // either — the run that would have collected them is the one being replaced,
    // and nothing downstream knows they exist.
    void stopRunningTasks(existing, sessionId);
    existing.abortController?.abort();
    existing.releaseInput?.();
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    // The only handle that stops the CLI process rather than just the turn.
    // Re-registered runs carry the one they were started with.
    abortController: abortController || carried?.abortController || null,
    // Shared by reference with the run loop that fills it, so re-registering a
    // run must hand back the same map rather than start an empty one.
    runningTasks: runningTasks || carried?.runningTasks || null
  });
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
  // No process, no background work: anything still tracked was killed with it.
  backgroundWork.clear(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Registers a stand-in session so the abort path can be exercised without
 * spawning a real CLI.
 *
 * Test-only. Real runs register themselves through `addSession`, and the entry
 * installed here is removed by the abort under test, exactly as a live one is.
 *
 * @param {string} sessionId - Session identifier
 * @param {Object} session - Session record to install
 */
export function registerActiveSessionForTests(sessionId, session) {
  activeSessions.set(sessionId, session);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * True when a usage payload carries no tokens at all.
 *
 * Local commands (a /compact, for one) run through the same stream and emit
 * assistant-shaped messages whose usage is all zeroes. Building a budget from
 * one of those would push a "0 used" frame at the composer and wipe the count
 * the previous assistant message had just set.
 * @param {Object} messageUsage - Anthropic-shaped usage payload
 * @returns {boolean}
 */
function isEmptyUsage(messageUsage) {
  const counters = [
    messageUsage.input_tokens ?? messageUsage.inputTokens,
    messageUsage.output_tokens ?? messageUsage.outputTokens,
    messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens,
    messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens,
  ];
  return counters.every((value) => !readNumber(value));
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {string|null} [model] - Model the payload belongs to, for the denominator
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage, model = null) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(model);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  // An all-zero payload would publish "0 used" and reset the counter the last
  // real assistant message had just set.
  if (isEmptyUsage(messageUsage)) {
    return null;
  }

  return buildTokenBudget(messageUsage, sdkMessage.message?.model);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  // The single modelUsage key names the model the turn billed, which is the
  // best denominator hint a result carries; `model` is the fallback for
  // builds that expose it directly.
  const resultModel = sdkMessage.model
    ?? (sdkMessage.modelUsage && typeof sdkMessage.modelUsage === 'object'
      ? Object.keys(sdkMessage.modelUsage)[0]
      : null);

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    // Same all-zero hazard as the assistant path: a local command's result
    // must not zero out a counter something else set.
    if (isEmptyUsage(sdkMessage.usage)) {
      return null;
    }

    return buildTokenBudget(sdkMessage.usage, resultModel);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindow(modelKey);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * True when an SDK message marks a context compaction.
 *
 * The CLI reports the boundary as a system message with `subtype:
 * 'compact_boundary'`; the SDK passes it through untyped, so nothing here can
 * be trusted to a shape — both the system-wrapped and the top-level forms are
 * read.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean}
 */
function isCompactionEvent(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return false;
  }

  if (sdkMessage.type === 'compact_boundary') {
    return true;
  }

  return sdkMessage.type === 'system' && sdkMessage.subtype === 'compact_boundary';
}

/**
 * Reads the context size a compaction left behind.
 *
 * `post_tokens` is what the window holds after the boundary — everything the
 * conversation was compacted into. It is the honest budget for the fresh
 * window: the next assistant message would report it too, but only after the
 * next request has already been made.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {number|null} Post-compaction token count, or null
 */
function readCompactBoundaryTokens(sdkMessage) {
  if (!isCompactionEvent(sdkMessage)) {
    return null;
  }

  const metadata = sdkMessage.compact_metadata ?? sdkMessage.compactMetadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const postTokens = readNumber(metadata.post_tokens ?? metadata.postTokens);
  return postTokens > 0 ? postTokens : null;
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, so the process has to be held open for it to report back.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 * @returns {{
 *   apply: (sessionKey: string, message: Object) => void,
 *   hasOutstanding: (sessionKey: string) => boolean,
 *   has: (sessionKey: string, taskId: string) => boolean,
 *   clear: (sessionKey: string) => void,
 *   list: () => Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>
 * }}
 */
export function createBackgroundWorkTracker() {
  /** @type {Map<string, Map<string, import('@/shared/types.js').BackgroundTaskSummary>>} */
  const sessions = new Map();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   * @type {Map<string, Set<string>>}
   */
  const ownToolUseIds = new Map();

  const remove = (sessionKey, taskId) => {
    const tasks = sessions.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      sessions.delete(sessionKey);
    }
  };

  return {
    apply(sessionKey, message) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Set();
                ownToolUseIds.set(sessionKey, ids);
              }
              ids.add(block.id);
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          if (typeof message.tool_use_id !== 'string') {
            return;
          }
          const task = {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          if (!ownToolUseIds.get(sessionKey)?.has(message.tool_use_id)) {
            task.nested = true;
          }
          let tasks = sessions.get(sessionKey);
          if (!tasks) {
            tasks = new Map();
            sessions.set(sessionKey, tasks);
          }
          tasks.set(task.taskId, task);
          return;
        }
        case 'task_notification':
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated':
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
          }
          return;
        default:
      }
    },

    hasOutstanding(sessionKey) {
      return sessions.has(sessionKey);
    },

    has(sessionKey, taskId) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    clear(sessionKey) {
      sessions.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * The `system` subtypes that open, amend, and close a spawned task.
 */
const TASK_EVENT_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification']);

/**
 * The task statuses after which a task is no longer running.
 */
const TASK_TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

/**
 * Records a spawned task's lifecycle against the session that started it.
 *
 * A backgrounded agent is not a turn, so nothing else in the run loop notices it:
 * by the time the client is told the run is over its tasks are still spending.
 * Keeping a registry of them is what lets "stop this session" mean stop
 * everything it started, rather than only the turn in front of the user.
 *
 * The tool call that spawned the task is kept beside it so a stop can be reported
 * against the card the task belongs to. `task_updated` carries only a `task_id`,
 * so it can amend a status but never supplies the spawning id — the one recorded
 * at `task_started` is the one that lasts.
 *
 * Used by the providers module's tests, which pin the event handling directly:
 * the alternative is driving a whole SDK run to observe whether a task was still
 * in the registry, and the cost of getting this wrong is a stop that misses work
 * which is still spending.
 *
 * @param {Map} runningTasks - Session-scoped task registry, task id to tool-use id
 * @param {Object} sdkMessage - Raw SDK stream message
 */
export function trackRunningTasks(runningTasks, sdkMessage) {
  if (sdkMessage?.type !== 'system' || !TASK_EVENT_SUBTYPES.has(sdkMessage.subtype)) {
    return;
  }

  const taskId = sdkMessage.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    return;
  }

  if (sdkMessage.subtype === 'task_started') {
    runningTasks.set(taskId, typeof sdkMessage.tool_use_id === 'string' ? sdkMessage.tool_use_id : null);
    return;
  }

  // A notification always closes its task; a patch only does when the status it
  // carries is one a task cannot come back from. A `task_progress` carries no
  // status at all, and must not be read as one.
  const status = sdkMessage.subtype === 'task_updated'
    ? sdkMessage.patch?.status
    : sdkMessage.status;
  if (sdkMessage.subtype === 'task_notification' || TASK_TERMINAL_STATUSES.has(status)) {
    runningTasks.delete(taskId);
  }
}

/**
 * Reports one stopped task on the session's run stream.
 *
 * The CLI sends a `task_notification` saying `stopped` for a task it was asked to
 * stop, but it cannot be relied on for this: in a bulk stop the process is closed
 * moments later, and in a single stop the notification is several round trips away.
 * Reporting the stop here means the client learns the outcome immediately, and
 * learns it the same way on both paths. Reporting it twice is harmless — the two
 * agree, and the client folds them into the same card.
 *
 * A task with no recorded tool call has no card to report against, so it is
 * skipped rather than reported against nothing.
 *
 * @param {Object} session - Session record from the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - Provider task id
 * @param {string|null|undefined} toolUseId - Tool call that spawned the task
 */
function reportTaskStopped(session, sessionId, taskId, toolUseId) {
  if (!toolUseId) {
    return;
  }

  try {
    session.writer?.send?.(createNormalizedMessage({
      id: `${sessionId}_task_stopped_${taskId}`,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: 'claude',
      kind: 'subagent_update',
      toolId: toolUseId,
      subagent: { id: taskId, status: 'stopped', toolUseId },
    }));
  } catch (error) {
    // Reporting the stop is best-effort. The stop itself already happened.
    console.warn(`Failed to report stopped task ${taskId} for session ${sessionId}:`, error?.message || error);
  }
}

/**
 * Reports a terminal `stopped` for every task still on the registry when the
 * run itself is winding down — the stream has ended or the process has failed,
 * so the CLI will never send their `task_notification`.
 *
 * `task_notification` is the only event that retires a task, which is why a
 * process that dies (or a release that lands before the notification does)
 * leaves the client's card pulsing forever: nothing ever contradicts the last
 * `task_started`. Sending it here does not conflict with the abort path, which
 * reports through `settleAskedTasks` before the same registry is cleared.
 *
 * Duplicates are harmless either way — the client folds updates into the same
 * card. Entries without a spawning tool call are skipped: there is no card to
 * report against.
 *
 * @param {Object} ws - WebSocket writer for the run's client
 * @param {string|null} sessionId - Session identifier
 * @param {Map} runningTasks - Task id to spawning tool-use id
 */
function settleRunningTasks(ws, sessionId, runningTasks) {
  if (!runningTasks || runningTasks.size === 0) {
    return;
  }

  for (const [taskId, toolUseId] of runningTasks.entries()) {
    if (!toolUseId) {
      continue;
    }

    try {
      ws?.send?.(createNormalizedMessage({
        id: `${sessionId}_task_stopped_${taskId}`,
        sessionId,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        kind: 'subagent_update',
        toolId: toolUseId,
        subagent: { id: taskId, status: 'stopped', toolUseId },
      }));
    } catch (error) {
      console.warn(`Failed to settle task ${taskId} for session ${sessionId}:`, error?.message || error);
    }
  }
  runningTasks.clear();
}

/**
 * Sends one `stop_task` and reports whether the runtime accepted it.
 *
 * Bounded, because a control channel that has stopped answering must not leave a
 * click hanging. Unlike the bulk stop, this answer is acted on: only an accepted
 * request means the task is going, and the caller tells the user the outcome.
 *
 * @param {Object} instance - SDK query instance
 * @param {string} taskId - Provider task id
 * @returns {Promise<boolean>} True when the request was accepted
 */
async function requestTaskStop(instance, taskId) {
  let timer = null;
  try {
    const accepted = await Promise.race([
      Promise.resolve(instance.stopTask(taskId)).then(() => true, () => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), TASK_STOP_GRACE_MS);
      }),
    ]);
    return accepted === true;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Resolves after `ms`, so a long wait can be walked in slices. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Asks every task the session still has running to stop, and returns what it asked.
 *
 * This is the whole of what a runtime can do to a spawned task from the outside: a
 * `stop_task` control message on the CLI's own channel. It is a signal, not a kill —
 * the task ends itself in response and says so with a `task_notification`, which is
 * why the caller has to wait for the answer rather than assume one. That wait is
 * `settleAskedTasks`.
 *
 * Dispatched rather than awaited: the caller owns the question of how long the
 * answers are worth waiting for, and on one path (a run being replaced) they are
 * worth no wait at all. The messages have left this process by the time this returns,
 * so a caller about to close that process can still call this first.
 *
 * @param {Object} session - Session record from the active sessions map
 * @returns {Array} Task id / spawning tool call pairs that were asked to stop
 */
function requestTaskStops(session) {
  const runningTasks = session?.runningTasks;
  const instance = session?.instance;
  if (!runningTasks || runningTasks.size === 0 || typeof instance?.stopTask !== 'function') {
    return [];
  }

  const asked = Array.from(runningTasks.entries());
  for (const [taskId] of asked) {
    // Settled rather than trusted: a request that is refused or ignored changes
    // nothing here, because whatever the task does with it, the caller of this path
    // is about to take the process away.
    void settleWithin(instance.stopTask(taskId), TASK_STOP_GRACE_MS);
  }

  return asked;
}

/**
 * Waits for the tasks that were asked to stop to end on their own, then accounts for
 * the ones that did not.
 *
 * This is the difference between signalling a task and stopping it. A task that
 * settles inside the grace is reported by the CLI itself, through the same
 * `task_notification` that takes it out of the registry — nothing is said about it
 * here, because saying it twice is saying it worse. Only the tasks still running when
 * the wait runs out are reported from here: they are about to lose the process that
 * runs them, so they are stopped either way, and this is the last side left that can
 * say so.
 *
 * Bounded, always: an agent that ignores the request must not be able to hold the stop
 * up, and the caller is on a path where a process still has to be closed.
 *
 * @param {Object} session - Session record from the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Array} asked - Task id / tool call pairs that were asked to stop
 * @param {number} gracePeriodMs - Longest to wait for them to end on their own
 */
async function settleAskedTasks(session, sessionId, asked, gracePeriodMs) {
  const runningTasks = session?.runningTasks;
  if (!asked?.length || !runningTasks) {
    return;
  }

  const deadline = Date.now() + Math.max(0, gracePeriodMs);
  while (Date.now() < deadline && asked.some(([taskId]) => runningTasks.has(taskId))) {
    await delay(Math.min(TASK_SETTLE_POLL_MS, deadline - Date.now()));
  }

  for (const [taskId, toolUseId] of asked) {
    if (!runningTasks.has(taskId)) {
      continue;
    }
    reportTaskStopped(session, sessionId, taskId, toolUseId);
    runningTasks.delete(taskId);
  }
}

/**
 * Stops the session's tasks and reports them, without waiting for them to end.
 *
 * For the path where the process is closed immediately afterwards: what the tasks do
 * with the signal before then is moot, because the process they run in is going. A
 * caller that can afford to let them wind down first waits instead, and passes a grace
 * period to `settleAskedTasks`.
 *
 * @param {Object} session - Session record from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Promise<number>} How many tasks were asked to stop
 */
async function stopRunningTasks(session, sessionId) {
  const asked = requestTaskStops(session);
  await settleAskedTasks(session, sessionId, asked, 0);
  return asked.length;
}

/**
 * Stops one task the session is still running, named by the tool call it came from.
 *
 * Addressed by tool-use id rather than by task id because that is the only one the
 * client ever holds: a task id appears only on the provider's own task events, while
 * the card the user is looking at is keyed by the call that spawned the agent. The
 * lookup is the session's own registry, which also scopes the request for free — a
 * tool-use id belonging to some other session is simply not in it.
 *
 * Unlike the bulk stop, a failure is reported rather than swallowed. The process
 * stays alive on this path, so a task that was not stopped is still running, and
 * calling it stopped would be the same lie the stop exists to remove.
 *
 * @param {string} sessionId - Session identifier
 * @param {string} toolUseId - Tool call that spawned the agent
 * @returns {Promise<boolean>} True when the runtime accepted the stop
 */
async function abortClaudeSubagent(sessionId, toolUseId) {
  const session = getSession(sessionId);
  const runningTasks = session?.runningTasks;
  const instance = session?.instance;
  if (!toolUseId || !runningTasks || typeof instance?.stopTask !== 'function') {
    return false;
  }

  const match = Array.from(runningTasks.entries()).find(([, id]) => id === toolUseId);
  if (!match) {
    return false;
  }

  const [taskId] = match;
  if (!await requestTaskStop(instance, taskId)) {
    return false;
  }

  // Dropped only once the stop was accepted: a refused request leaves the task
  // running, and it has to stay reachable for a second attempt.
  runningTasks.delete(taskId);
  reportTaskStopped(session, sessionId, taskId, toolUseId);
  console.log(`Stopped subagent ${taskId} for session ${sessionId}`);
  return true;
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * `push` feeds additional turns into the live stream: the CLI's stream-input
 * mode reads the next user message from stdin once the current turn ends, so a
 * pushed message is the whole of "send this queued message now". After release,
 * push reports false — the stream is closing and a turn pushed into it would
 * never be read.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, push: (message: Object) => boolean, release: () => void }}
 */
function createHeldPromptStream(messages) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let notifyArrival = null;
  let released = false;
  const pending = [];

  const stream = (async function* () {
    for (const message of messages) {
      yield message;
    }
    // Keeps stdin open — the CLI stays alive until release() is called — and
    // feeds anything pushed while it is open as further turns.
    while (!released) {
      if (pending.length > 0) {
        yield pending.shift();
        continue;
      }
      // Park until a push arrives or the release ends the stream. The resolver
      // is refreshed per wait: pushes that land while the generator is busy
      // yielding simply queue up and are drained by the check above.
      await new Promise((resolve) => {
        notifyArrival = resolve;
        // release() may already have been called between checks.
        if (released) {
          resolve();
        }
      });
    }
  })();

  return {
    stream,
    push(message) {
      if (released) {
        return false;
      }
      pending.push(message);
      notifyArrival?.();
      return true;
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      release();
      // The generator is parked on the arrival signal, not on `held` — waking
      // it is what actually ends the stream and closes stdin.
      notifyArrival?.();
    },
  };
}

// Live held streams by session key, so a queued message can be pushed into the
// run that is actually holding the session's process. Entries are registered
// when a run starts and removed when it ends, always guarded by identity: a run
// replaced by a newer one must not delete the newer run's entry.
const heldPromptStreams = new Map();

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // Streaming increments seen this turn, reported when it ends. Counting them is how
  // "the model produced no reasoning" is told apart from "the reasoning never reached
  // us" — two states that otherwise look identical from the outside, and the second
  // of which is a silent misreading of the wire format.
  let textDeltaCount = 0;
  let thinkingDeltaCount = 0;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold; `startsBackgroundWork` is the fallback
  // for tools that emit none (Monitor, ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // Injected queued turns and results seen. A run starts expecting exactly one
  // result — the initial turn's — and every successful push raises that by one;
  // a `result` with turns still outstanding is intermediate, and the terminal
  // `complete` waits for the last one.
  let injectedTurnCount = 0;
  let resultCount = 0;

  // A new turn supersedes any earlier one still holding this session's process
  // open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    getSession(sessionKey())?.releaseInput?.();
  }

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream();
    }, BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;
  // Same hoisting for the injection point: the finally block must be able to
  // name it even when the try failed before the stream existed at all.
  let heldPromptHandle = null;

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // The handle this run is stopped by.
    //
    // Note what aborting it does and does not do: it closes the SDK's process
    // transport, which ends the CLI's stdin and then escalates to a kill if the
    // process is still alive — SIGTERM on POSIX after the SDK's ~2s grace
    // window, and SIGKILL (TerminateProcess on Windows) a further 5s later. It
    // is not instant, and `Query.close()` would reach the very same path. What
    // matters is that the escalation is bounded: without closing the transport
    // the CLI outlives the abort for the rest of BG_WAIT_CEILING_MS.
    const abortController = new AbortController();
    sdkOptions.abortController = abortController;

    // Ask for the turn as it is written. Set on the run rather than in the option
    // mapper because it describes how this run's stream is to be delivered, which is
    // the same reason the controller above is here.
    sdkOptions.includePartialMessages = INCLUDE_PARTIAL_MESSAGES;

    // Every task this run spawns, so a stop can end all of them rather than only
    // the turn in front of the user. The same map is carried through the
    // re-registrations below, which is what keeps the session's copy and this
    // loop's copy the same one.
    const runningTasks = new Map();

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    const createQuery = context.createQuery ?? query;

    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    try {
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    }

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, abortController, runningTasks);
    }

    // Expose this run's held stream as an injection point. A push that the
    // stream accepted is one more turn the CLI owes a result for, and the idle
    // ceiling re-arms so the hold cannot expire while a queued turn is owed.
    // Identity-guarded cleanup in the finally block keeps a superseding run's
    // registration intact.
    heldPromptHandle = {
      push(message) {
        const accepted = heldPrompt.push(message);
        if (accepted) {
          injectedTurnCount += 1;
          scheduleRelease();
        }
        return accepted;
      },
    };
    if (sessionKey()) {
      heldPromptStreams.set(sessionKey(), heldPromptHandle);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Tracked before anything else can drop or transform the message: a task
      // that opens here is what a later stop has to be able to find.
      trackRunningTasks(runningTasks, message);

      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream, abortController, runningTasks);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        // The runtime, not the transcript, decides whether an agent can still be
        // stopped: it is the only side that holds the task handle. Stamping it here
        // is what keeps the client from drawing a control the runtime could not
        // honour — a transcript-read agent that only *looks* running has no handle.
        if (msg.kind === 'subagent_update' && msg.subagent?.id && runningTasks.has(msg.subagent.id)) {
          msg.subagent.canInterrupt = true;
        }
        if (msg.kind === 'stream_delta') {
          textDeltaCount += 1;
        } else if (msg.kind === 'thinking_delta') {
          thinkingDeltaCount += 1;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        ws.send(msg);
      }

      // Learn the real context window from the turn's bill. The SDK's model
      // info carries no window; `result.modelUsage[<model>].contextWindow`
      // does. Learning it here is what lets the composer's denominator follow
      // the model actually in use — a 1M-window model read against the 160k
      // default looks permanently nearly-full.
      learnContextWindowsFromResult(message);

      // A compaction turn rewrites the window: the assistant budget read
      // earlier belongs to the pre-compact conversation, and the turn-ending
      // bill is the compaction's own. Latch the assistant flag so neither can
      // overwrite what follows, and publish `post_tokens` — the size of the
      // window the conversation actually resumes into.
      const compactedTokens = readCompactBoundaryTokens(message);
      if (compactedTokens !== null) {
        assistantBudgetSent = true;
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget: {
            used: compactedTokens,
            total: resolveContextWindow(),
            inputTokens: compactedTokens,
            outputTokens: 0,
            breakdown: {
              input: compactedTokens,
              output: 0,
            },
          },
          sessionId: capturedSessionId || sessionId || null,
          provider: 'claude'
        }));
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      const tokenBudgetData = extractTokenBudget(message)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message));
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }
      if (message.type === 'system' && message.subtype === 'task_started') {
        sawTaskEventThisTurn = true;
      }
      backgroundWork.apply(sessionKey(), message);

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here. A
      // completed task is different: the CLI relays its result in a turn of
      // its own, which closing stdin now would cut short.
      if (
        heldForBackgroundWork
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasOutstanding(sessionKey())
      ) {
        heldForBackgroundWork = false;
        releasePromptStream();
      }

      if (message.type === 'result') {
        resultCount += 1;

        // One line per turn: enough to tell whether partial events are arriving and
        // whether reasoning is among them, without a client attached. A turn that
        // answers in text but streams none of it is the failure this exists to catch.
        console.log(
          `[claude] turn stream for ${sid}: ${textDeltaCount} text increments, ${thinkingDeltaCount} reasoning increments`
        );
        textDeltaCount = 0;
        thinkingDeltaCount = 0;

        // A result with turns still owed — a queued message was pushed
        // mid-turn — is intermediate: the client stays processing and stdin
        // stays open until the last injected turn lands. Only then does the
        // terminal `complete` go out.
        const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
        const stillOutstanding = backgroundWork.hasOutstanding(sessionKey());
        const pendingInjectedTurns = !abortPending && injectedTurnCount + 1 - resultCount > 0;
        if (pendingInjectedTurns) {
          scheduleRelease();
        } else if (!turnCompleteSent && !abortPending) {
          turnCompleteSent = true;
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
        } else if (heldForBackgroundWork && !abortPending && !stillOutstanding) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn
          // — the last of it, when nothing else is still running.
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary
          });
        }
        if (pendingInjectedTurns) {
          // Hold for the injected turn; the schedule above re-armed the
          // ceiling. The hold is reported so a later result from a turn with
          // no outstanding work still releases the process.
          scheduleRelease();
          heldForBackgroundWork = true;
        } else {
          // Work started during this turn, or work from an earlier turn that
          // has not settled yet (a follow-up turn reports one task in while
          // another is still going), is still running. Hold the process open
          // so it can finish and report back in a follow-up turn; the ceiling
          // is only a backstop for work that never reports.
          //
          // The release when the last task settles is this same branch on the
          // follow-up turn the CLI pushes for it, not the settling event
          // itself: closing stdin at that moment would cut the turn that
          // relays the task's result.
          //
          // When the turn reported its tasks, the tracker is the whole truth: an
          // Agent call without `run_in_background` is scored as background by
          // `startsBackgroundWork`, but the CLI runs it in the foreground and
          // it has settled before this `result` — holding for it kept a process
          // alive for the full ceiling with nothing outstanding.
          const holdForTurn = sawTaskEventThisTurn ? stillOutstanding : backgroundWorkPending || stillOutstanding;
          backgroundWorkPending = false;
          sawTaskEventThisTurn = false;
          if (holdForTurn) {
            heldForBackgroundWork = true;
            scheduleRelease();
          } else {
            // Either nothing was backgrounded, or the background work just
            // reported in — let the CLI exit now, as it always has.
            heldForBackgroundWork = false;
            releasePromptStream();
          }
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // The stream has ended, so any task still registered will never send its
    // own notification — report the terminal the CLI will not. Superseded runs
    // say nothing: the run that replaced them owns the client.
    if (!superseded) {
      settleRunningTasks(ws, capturedSessionId || sessionId || null, runningTasks);
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      // Tasks were settled by the abort path itself (settleAskedTasks).
      return;
    }

    // The process is failing outright — tasks still on the registry will never
    // report. Settle them before the error surfaces, so the cards end in a
    // terminal state rather than pulsing behind an error row.
    settleRunningTasks(ws, capturedSessionId || sessionId || null, runningTasks);

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    releasePromptStream();
    // Identity-guarded: a queued message may have started the session's next
    // run before this promise settles, and that run owns the entry now.
    if (sessionKey() && heldPromptStreams.get(sessionKey()) === heldPromptHandle) {
      heldPromptStreams.delete(sessionKey());
    }
  }
}

/**
 * Waits for a promise, but never longer than `timeoutMs`.
 *
 * Used to bound the graceful half of an abort. The stop that follows it must not
 * be able to hang just because the runtime it is stopping stopped responding,
 * and a rejection here is not a failure — it is the signal to go straight to the
 * hard stop.
 *
 * @param {Promise<unknown>} promise - Work to wait for
 * @param {number} timeoutMs - Longest to wait
 */
function settleWithin(promise, timeoutMs) {
  return Promise.race([
    Promise.resolve(promise).catch((error) => {
      console.warn('Graceful stop failed; continuing with the hard stop:', error?.message || error);
    }),
    // Deliberately not unref'd: this timer is the only thing that can settle the
    // race when the work being waited on never does, and an unref'd timer is
    // allowed to be skipped entirely once the loop has nothing else to do.
    new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

/**
 * Aborts an active SDK session.
 *
 * The order is deliberate, and it is the whole shape of a graceful stop: signal the
 * session's spawned tasks, end the turn the user is watching, give those tasks the
 * grace period to end on their own, and only then take the process away. Nothing
 * before that last step kills anything — a task that answers the signal in time stops
 * by its own choice, and the process close exists for whatever did not answer.
 *
 * @param {string} sessionId - Session identifier
 * @param {Object} [options] - Stop policy
 * @param {number} [options.subagentStopGraceMs] - How long spawned tasks get to end on
 *   their own before the process is closed. Defaults to SUBAGENT_STOP_GRACE_MS.
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId, options = {}) {
  const session = getSession(sessionId);
  const stopGraceMs = Number.isFinite(options?.subagentStopGraceMs)
    ? Math.max(0, options.subagentStopGraceMs)
    : SUBAGENT_STOP_GRACE_MS;

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before stopping so the run loop knows not to emit its own terminal
    // complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Signal what the session spawned before anything else. Those tasks outlive the
    // turn, so ending the turn is not something they are told about on their own — and
    // `stop_task` is a control request over the CLI's own channel, so it has to go out
    // while that channel is still open.
    //
    // A signal, not a kill: the tasks end themselves, and the grace period below is
    // where they get to.
    const askedTasks = requestTaskStops(session);
    if (askedTasks.length > 0) {
      console.log(`Asked ${askedTasks.length} running task(s) to stop for session ${sessionId}`);
    }

    // Ask the turn to stop as well, so the CLI can finish writing the turn it is
    // abandoning. Bounded, because nothing below may depend on it.
    //
    // Deliberately ahead of the task grace: the turn is what the user is watching, so
    // it has to end now. The tasks are winding down behind it either way.
    await settleWithin(session.instance.interrupt(), INTERRUPT_GRACE_MS);

    // Now let the tasks end on their own, before the process is taken from them. This
    // is the whole of "signal, then wait": a task that reaches a stopping point inside
    // the grace reports itself and is never cut short, and the ones that do not are
    // accounted for by `settleAskedTasks`.
    await settleAskedTasks(session, sessionId, askedTasks, stopGraceMs);

    // Hard stop: this is the difference between the UI saying "stopped" and the
    // work actually being stopped.
    //
    // The signal above only reaches a task that is still there to receive it, and the
    // grace only ends the ones that chose to end. Anything left over — a task that
    // ignored its request, work that was never a task at all, a backgrounded shell —
    // would otherwise keep running and spending for the rest of the CLI's post-turn
    // ceiling, which is BG_WAIT_CEILING_MS (30 minutes) here, while the client has
    // already been told the run is over.
    //
    // close() tears the subprocess down immediately — the SDK kills the CLI process
    // group and frees every resource the query holds. Without it the transport's own
    // escalation after abort() would end the CLI within a bounded few seconds, but
    // "bounded" still meant waiting out that timer while an ignored stop_task kept
    // spending. Guarded: it is a last resort layered under the abort below, not a
    // replacement for it.
    try {
      session.instance?.close?.();
    } catch (closeError) {
      console.error(`Error closing session process ${sessionId}:`, closeError);
    }

    // Aborting the controller closes the process transport and releases anything
    // still parked on it. Synchronous, and it cannot throw.
    session.abortController?.abort();

    // Release the held stdin stream as a second exit path — a runtime that
    // ignored the abort must not be able to sit on the hold timer.
    session.releaseInput?.();

    // Update session status and drop the entry, but only while it still belongs
    // to the run being stopped. The awaits above give a queued message time to
    // register the session's next run under the same key, and removing that one
    // would strand it with no handle to abort it by.
    if (getSession(sessionId)?.instance === session.instance) {
      session.status = 'aborted';
      removeSession(sessionId);
    }

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as the process
 * is held open for the work — which is exactly the window in which nothing
 * else (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 * @returns {Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>}
 */
function listClaudeSDKBackgroundWork() {
  return backgroundWork.list();
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await session.instance.stopTask(taskId);
  return true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  // Coerced: an absent entry is not "active", and callers asking a yes/no
  // question should not have to distinguish `false` from `undefined`.
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * Pushes a queued message into a running session's held stdin stream.
 *
 * The CLI's stream-input mode reads the next user message once the current turn
 * ends, so pushing is the whole of "send this queued message now": the turn
 * starts the moment the present one finishes, without a dispatcher poll in
 * between. The run loop counts the owed turn and keeps its terminal `complete`
 * back until it lands.
 *
 * Fails (returns false) when the session has no live held stream — nothing is
 * running, or it has already started closing — and the caller must leave the
 * queued message in place for the dispatcher.
 *
 * @param {string} sessionId - App session identifier the run was registered under
 * @param {string} content - Queued message text
 * @returns {boolean} True when the turn was accepted into the live stream
 */
function injectIntoRunningClaudeTurn(sessionId, content) {
  if (typeof content !== 'string' || !content.trim()) {
    return false;
  }

  const handle = sessionId ? heldPromptStreams.get(sessionId) : null;
  if (!handle) {
    return false;
  }

  return handle.push({
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  });
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  abortSubagent: abortClaudeSubagent,
  injectIntoRunningTurn: injectIntoRunningClaudeTurn,
  // True from run start until the stream actually ends — including the
  // held-open window after `complete`, while background agents keep the
  // process alive. The chat gateway locks new runs out of the session on it.
  isSessionProcessAlive: isClaudeSDKSessionActive,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  abortClaudeSubagent,
  injectIntoRunningClaudeTurn,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
