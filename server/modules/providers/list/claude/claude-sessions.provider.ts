import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  CompactionInfo,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
  SubagentStatus,
  SubagentUsage,
} from '@/shared/types.js';
import { parseFilesInputTag } from '@/shared/image-attachments.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  sliceTailPage,
  stripAnsiSequences,
  truncateSubagentActivity,
} from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';
import { summarizeClaudeTokenUsage } from '@/modules/providers/services/provider-token-usage.service.js';

const PROVIDER = 'claude';

/** Tokens the way the CLI writes them: 725k rather than 724,871. */
const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${tokens}`;
};

/** A duration the way the CLI writes one: `2m 22s`. */
const formatDuration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/**
 * Upper bound on how much of a subagent's timeline is sent to the client. A
 * long-running agent can record hundreds of tool calls, and the transcript only
 * ever shows them behind a collapsed header, so shipping the whole history on
 * every load costs far more than it shows.
 */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

/**
 * How long a subagent's transcript may stay silent (no new writes) before a
 * history read stops calling the agent `running`.
 *
 * An aborted agent's launch result was overwritten with a plain string and no
 * notification ever arrives, so the transcript's own mtime is the only signal
 * left. The window exists because a legitimately slow agent also writes
 * nothing for a while — such an agent is briefly misread as stopped, and its
 * next write corrects that on the following read.
 */
const SUBAGENT_LIVENESS_WINDOW_MS = 15 * 60 * 1000;

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: SubagentActivity[];
  subagent?: SubagentInfo;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

type ClaudeSubagentTranscript = {
  activity: SubagentActivity[];
  model?: string;
  /**
   * True when the transcript's last tool call never received a result, which
   * is the only evidence in the file that the agent stopped mid-flight.
   */
  endedMidToolCall: boolean;
};

/**
 * Flattens one subagent transcript into the shared activity timeline.
 *
 * Assistant prose and reasoning are kept alongside the tool calls so the
 * transcript can replay what the agent actually did rather than listing tool
 * names with no narrative.
 */
async function readClaudeSubagentTranscript(filePath: string): Promise<ClaudeSubagentTranscript> {
  const activity: SubagentActivity[] = [];
  const transcript: ClaudeSubagentTranscript = { activity, endedMidToolCall: false };
  const toolsById = new Map<string, SubagentActivity>();

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          if (typeof entry.message.model === 'string') {
            transcript.model = entry.message.model;
          }

          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              const tool: SubagentActivity = {
                kind: 'tool',
                toolId: String(part.id ?? ''),
                toolName: String(part.name ?? 'Tool'),
                toolInput: part.input,
                timestamp,
              };
              activity.push(tool);
              if (tool.toolId) {
                toolsById.set(tool.toolId, tool);
              }
              continue;
            }
            if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              activity.push({ kind: 'text', content: part.text, timestamp });
              continue;
            }
            if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
              activity.push({ kind: 'thinking', content: part.thinking, timestamp });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = toolsById.get(String(part.tool_use_id ?? ''));
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  const lastActivity = activity[activity.length - 1];
  transcript.endedMidToolCall = lastActivity?.kind === 'tool' && !lastActivity.toolResult;

  return transcript;
}

type ClaudeSubagentMeta = {
  agentType?: string;
  description?: string;
  toolUseId?: string;
};

/** Reads the sidecar `.meta.json` Claude writes next to a subagent transcript. */
async function readClaudeSubagentMeta(metaPath: string): Promise<ClaudeSubagentMeta> {
  try {
    const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as AnyRecord;
    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      toolUseId: typeof parsed.toolUseId === 'string' ? parsed.toolUseId : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolves where a subagent's transcript lives.
 *
 * Current Claude versions write it to
 * `<projectDir>/<providerSessionId>/subagents/agent-<agentId>.jsonl`; older
 * ones dropped it next to the parent transcript. Both are checked, newest
 * layout first, because a project directory usually holds sessions from
 * several CLI versions.
 */
async function findClaudeSubagentTranscript(
  projectDirectory: string,
  providerSessionId: string,
  agentId: string,
): Promise<{ transcriptPath: string; metaPath: string } | null> {
  const candidates = [
    path.join(projectDirectory, providerSessionId, 'subagents', `agent-${agentId}.jsonl`),
    path.join(projectDirectory, `agent-${agentId}.jsonl`),
  ];

  for (const transcriptPath of candidates) {
    try {
      await fsp.access(transcriptPath);
      return { transcriptPath, metaPath: transcriptPath.replace(/\.jsonl$/, '.meta.json') };
    } catch {
      // Try the next layout.
    }
  }

  return null;
}

type ClaudeTaskNotification = {
  /** `uuid` of the transcript row the notification came from, so it can be dropped. */
  sourceUuid: string;
  toolUseId: string;
  status: string;
  summary: string;
  result: string;
};

function readTaggedValue(content: string, tagName: string): string {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`).exec(content);
  return match ? match[1].trim() : '';
}

/** Reads a string field that may be absent, empty, or of some other type. */
function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * The `system` subtypes that carry a spawned agent's lifecycle.
 *
 * `task_started` opens a task, `task_progress` amends it, and
 * `task_notification` closes it. All three name the `tool_use_id` of the call
 * that spawned the agent, which is what lets the client attach them to a row.
 *
 * `task_updated` is deliberately absent: it carries only the provider's own
 * `task_id`, so accepting it would mean keeping a task-to-tool mapping alive on
 * the server purely to translate an identifier. Its terminal outcomes arrive on
 * `task_notification` anyway, and only its transient states are lost.
 */
const CLAUDE_TASK_EVENT_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_notification',
]);

/**
 * Maps one Claude task status onto the subagent lifecycle the UI draws.
 *
 * The task stream and the transcript name the same states differently, so
 * `killed` and `stopped` both land on `stopped`, and a task that is owed but
 * not yet started already reads as running. An unrecognized status returns
 * `null` so the caller leaves the last known state in place rather than
 * inventing a transition.
 */
function mapClaudeTaskStatus(status: unknown): SubagentStatus | null {
  switch (status) {
    case 'pending':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'stopped':
      return 'stopped';
    default:
      return null;
  }
}

/**
 * Reads the `{ total_tokens, tool_uses, duration_ms }` accounting Claude puts on
 * task events.
 *
 * This is not the Anthropic usage shape, so it must never be read with the
 * budget helpers — doing so produced an all-zero counter mid-run.
 */
function readClaudeTaskUsage(usage: unknown): SubagentUsage | undefined {
  const record = readObjectRecord(usage);
  if (!record) {
    return undefined;
  }

  return {
    totalTokens: Number(record.total_tokens ?? record.totalTokens) || 0,
    toolUses: Number(record.tool_uses ?? record.toolUses) || 0,
    durationMs: Number(record.duration_ms ?? record.durationMs) || 0,
  };
}

/**
 * Normalizes one live Claude task event into a subagent status update.
 *
 * The tool call that spawns an agent cannot describe a *backgrounded* one: its
 * launch result returns as soon as the agent is admitted, so inferring status
 * from whether that result arrived made a still-running agent render as
 * finished. These events are the agent's real lifecycle, so the client is told
 * about each transition instead of being left to guess at one.
 *
 * Returns `null` when the event names no tool call — a task the transcript has
 * no row for, such as a backgrounded Bash command, has nothing to attach to —
 * and when the reported status is one the UI cannot draw.
 */
function normalizeClaudeTaskEvent(
  raw: AnyRecord,
  sessionId: string | null,
  id: string,
  timestamp: string,
): NormalizedMessage[] | null {
  const subtype = typeof raw.subtype === 'string' ? raw.subtype : '';
  if (!CLAUDE_TASK_EVENT_SUBTYPES.has(subtype)) {
    return null;
  }

  // Foreground Bash commands that run longer than ~2s also surface here as
  // task events — carrying `task_type: "local_bash"` and the Bash call's own
  // tool_use_id. They are not agents: forwarding them drew a phantom agent
  // container around the very tool call the reader was watching.
  if (readOptionalString(raw.task_type) === 'local_bash') {
    return null;
  }

  const toolUseId = readOptionalString(raw.tool_use_id);
  const taskId = readOptionalString(raw.task_id);
  if (!toolUseId || !taskId) {
    return null;
  }

  // Only a closing notification reports a status; the other two describe a
  // task that is still going.
  const status = mapClaudeTaskStatus(raw.status ?? 'running');
  if (!status) {
    return null;
  }

  const subagent: SubagentInfo = {
    // The task id, not the transcript's `agentId`: this path has not read the
    // agent's transcript yet, and the two are only reconciled once history does.
    id: taskId,
    status,
    toolUseId,
    type: readOptionalString(raw.subagent_type),
    description: readOptionalString(raw.description),
    usage: readClaudeTaskUsage(raw.usage),
  };

  return [createNormalizedMessage({
    id: `${id}_${subtype}_${taskId}`,
    sessionId,
    timestamp,
    provider: PROVIDER,
    kind: 'subagent_update',
    toolId: toolUseId,
    subagent,
  })];
}

/**
 * Collects every `<task-notification>` turn keyed by the tool call that
 * spawned the agent it reports on.
 *
 * Only notifications that name a tool-use id are collected: without one there
 * is no card to fold them into, and they must keep rendering on their own.
 */
function collectTaskNotifications(messages: AnyRecord[]): Map<string, ClaudeTaskNotification> {
  const notifications = new Map<string, ClaudeTaskNotification>();

  for (const message of messages) {
    if (message.message?.role !== 'user') {
      continue;
    }

    const content = message.message.content;
    const texts: string[] = typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter((part: AnyRecord) => part?.type === 'text').map((part: AnyRecord) => String(part.text ?? ''))
        : [];

    for (const text of texts) {
      if (!text.trimStart().startsWith('<task-notification>')) {
        continue;
      }

      const toolUseId = readTaggedValue(text, 'tool-use-id');
      if (!toolUseId) {
        continue;
      }

      // A resumed agent notifies more than once; the last word wins.
      notifications.set(toolUseId, {
        sourceUuid: String(message.uuid ?? ''),
        toolUseId,
        status: readTaggedValue(text, 'status') || 'completed',
        summary: readTaggedValue(text, 'summary'),
        result: readTaggedValue(text, 'result'),
      });
    }
  }

  return notifications;
}

/** Reads the `tool_use_id` off the tool-result row that launched an agent. */
function readAgentToolUseId(message: AnyRecord): string | null {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
      return part.tool_use_id;
    }
  }

  return null;
}

/** Swaps an agent launch acknowledgement for the agent's actual answer. */
function replaceAgentToolResultContent(message: AnyRecord, replacement: string): void {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const part of content) {
    if (part?.type === 'tool_result') {
      part.content = replacement;
    }
  }
}

/**
 * Reads a Claude transcript's rows as a graph keyed by `uuid`.
 *
 * The file is append-only and every row names its predecessor in `parentUuid`,
 * so a conversation is a path through it rather than the whole file. Editing a
 * sent message makes a second path appear alongside the first.
 */
async function readTranscriptRows(jsonlPath: string, providerSessionId: string): Promise<AnyRecord[]> {
  const rows: AnyRecord[] = [];
  const fileStream = fs.createReadStream(jsonlPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as AnyRecord;
      if (entry.sessionId === providerSessionId) {
        rows.push(entry);
      }
    } catch {
      // A row can be half-written while the CLI is streaming into the file.
    }
  }

  return rows;
}

/** True for a row the user typed, as opposed to a tool result or an injected note. */
function isUserPromptRow(row: AnyRecord): boolean {
  if (row.type !== 'user' || row.isMeta === true || row.isCompactSummary === true) {
    return false;
  }

  const content = row.message?.content;
  if (Array.isArray(content)) {
    return content.some((part: AnyRecord) => part?.type === 'text' || part?.type === 'image');
  }

  return typeof content === 'string' && content.length > 0;
}

/**
 * Drops the rows belonging to prompts that were replaced by an edit.
 *
 * When a message is edited, Claude resumes the conversation partway and appends
 * the replacement, so two prompts end up sharing one parent and the file holds
 * both the abandoned attempt and the live one. A flat read would show them
 * stacked, which reads as the app having sent the message twice.
 *
 * Only sibling *prompts* are treated as a fork. Branch points made by parallel
 * tool calls are extremely common — one assistant turn writes several chained
 * rows and each tool result parents onto its own — and pruning those would
 * delete tool output from every transcript in the app.
 */
function dropSupersededPromptBranches(rows: AnyRecord[]): AnyRecord[] {
  const promptSiblings = new Map<string, AnyRecord[]>();
  for (const row of rows) {
    if (typeof row.parentUuid !== 'string' || !isUserPromptRow(row)) {
      continue;
    }
    const siblings = promptSiblings.get(row.parentUuid);
    if (siblings) {
      siblings.push(row);
    } else {
      promptSiblings.set(row.parentUuid, [row]);
    }
  }

  const supersededRoots = new Set<string>();
  for (const siblings of promptSiblings.values()) {
    if (siblings.length < 2) {
      continue;
    }
    // The transcript is append-only, so the last prompt written under a parent
    // is the one that replaced the others.
    for (const row of siblings.slice(0, -1)) {
      if (typeof row.uuid === 'string') {
        supersededRoots.add(row.uuid);
      }
    }
  }

  if (supersededRoots.size === 0) {
    return rows;
  }

  const abandoned = new Set(supersededRoots);
  // Rows are appended in order, so one forward pass propagates each superseded
  // root to its whole subtree.
  for (const row of rows) {
    if (typeof row.parentUuid === 'string' && abandoned.has(row.parentUuid) && typeof row.uuid === 'string') {
      abandoned.add(row.uuid);
    }
  }

  return rows.filter((row) => typeof row.uuid !== 'string' || !abandoned.has(row.uuid));
}

async function getSessionMessages(
  sessionId: string,
  providerSessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    // The DB row is keyed by the app-facing session id, while the JSONL rows
    // on disk carry the provider-native id — both ids are needed here.
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const projectDir = path.dirname(jsonLPath);

    const messages = dropSupersededPromptBranches(
      await readTranscriptRows(jsonLPath, providerSessionId),
    );

    const agentIds = new Set<string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    // Read each spawned agent's own transcript once, then hang it off every
    // row that references it.
    //
    // A transcript that cannot be located is not a reason to drop the agent:
    // the spawn is still recorded in this transcript, and a card with its type
    // and description but an empty timeline is far more use than the plain tool
    // call it would otherwise collapse back into. `transcriptFound` keeps that
    // distinction explicit, because the status inference below depends on
    // knowing whether an unfinished timeline means anything.
    const subagentsById = new Map<string, {
      activity: SubagentActivity[];
      info: SubagentInfo;
      endedMidToolCall: boolean;
      transcriptFound: boolean;
      transcriptModifiedAtMs: number | null;
    }>();
    for (const agentId of agentIds) {
      const located = await findClaudeSubagentTranscript(projectDir, providerSessionId, agentId);
      const [transcript, meta, stats] = located
        ? await Promise.all([
          readClaudeSubagentTranscript(located.transcriptPath),
          readClaudeSubagentMeta(located.metaPath),
          fsp.stat(located.transcriptPath).then((fileStats) => fileStats.mtimeMs).catch(() => null),
        ])
        : [{ activity: [] as SubagentActivity[], endedMidToolCall: false }, {} as ClaudeSubagentMeta, null];

      subagentsById.set(agentId, {
        endedMidToolCall: transcript.endedMidToolCall,
        transcriptFound: Boolean(located),
        transcriptModifiedAtMs: stats,
        activity: transcript.activity
          .slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
          .map(truncateSubagentActivity),
        info: {
          id: agentId,
          name: meta.agentType,
          type: meta.agentType,
          description: meta.description,
          model: transcript.model,
          status: 'completed',
          activityCount: transcript.activity.length,
        },
      });
    }

    // An async agent's launch result is internal bookkeeping ("Async agent
    // launched successfully…"); its real answer arrives later as a separate
    // `<task-notification>` turn. Folding the notification back onto the tool
    // call that started the agent keeps one card per agent instead of a card,
    // an unrelated status line, and a stray markdown reply.
    const notificationsByToolUseId = collectTaskNotifications(messages);
    const foldedNotificationUuids = new Set<string>();

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const subagent = subagentsById.get(String(agentId));
      const toolUseId = readAgentToolUseId(message);
      const notification = toolUseId ? notificationsByToolUseId.get(toolUseId) : undefined;
      // An agent whose transcript has gone quiet past the liveness window while
      // ending mid-tool-call is the footprint of an abort: no notification will
      // ever arrive, so it must not keep the row running. It drops out of the
      // awaiting test (the row no longer reads as running) and settles as
      // `stopped` below — a cancellation, not a failure.
      const transcriptGoneQuiet = subagent?.transcriptModifiedAtMs != null
        && Date.now() - subagent.transcriptModifiedAtMs > SUBAGENT_LIVENESS_WINDOW_MS;
      // An async agent's launch row never tells you it finished — only the
      // later notification does. When that notification is missing (a live run,
      // or one compacted out of the transcript), the agent's own transcript is
      // the evidence: a timeline that does not stop mid-tool-call is done. An
      // unreadable transcript is evidence of nothing, so the agent stays
      // running rather than being declared finished on no information.
      const isAwaitingAsyncAgent = message.toolUseResult?.isAsync === true
        && !notification
        && !transcriptGoneQuiet
        && (!subagent?.transcriptFound || subagent.endedMidToolCall);
      // A notification is terminal by definition, and a cancellation is not a
      // failure: reading every non-completed status as one made a stopped agent
      // render as broken. Both statuses the UI can draw are kept, and anything
      // unrecognized falls back to completed so a finished agent cannot spin
      // forever.
      const reportedStatus = notification ? mapClaudeTaskStatus(notification.status) : null;
      const terminalStatus = reportedStatus === 'failed' || reportedStatus === 'stopped'
        ? reportedStatus
        : 'completed';
      const settledStatus: SubagentStatus = transcriptGoneQuiet && subagent?.endedMidToolCall
        ? 'stopped'
        : terminalStatus;

      if (subagent) {
        if (subagent.activity.length > 0) {
          message.subagentTools = subagent.activity;
        }
        message.subagent = {
          ...subagent.info,
          toolUseId: toolUseId ?? undefined,
          description: subagent.info.description
            ?? (typeof message.toolUseResult?.description === 'string' ? message.toolUseResult.description : undefined),
          model: subagent.info.model
            ?? (typeof message.toolUseResult?.resolvedModel === 'string' ? message.toolUseResult.resolvedModel : undefined),
          // The spawn row is the only place the agent's own prompt is recorded;
          // the agent's transcript echoes it as a user row the timeline folds
          // away, and the task events never carry it.
          prompt: typeof message.toolUseResult?.prompt === 'string' ? message.toolUseResult.prompt : undefined,
          status: isAwaitingAsyncAgent ? 'running' : settledStatus,
        };
      }

      if (notification) {
        replaceAgentToolResultContent(message, notification.result || notification.summary);
        foldedNotificationUuids.add(notification.sourceUuid);
      } else if (message.toolUseResult?.isAsync === true) {
        // Without a notification there is no answer to show, and the launch
        // acknowledgement is internal bookkeeping the user must never read.
        replaceAgentToolResultContent(message, '');
      }
    }

    // Orphan pass: when an agent is aborted, the CLI overwrites its launch
    // result with a plain string ("User rejected"), which erases the
    // toolUseResult.agentId that binds the spawn row to the agent — the row
    // drops out of the panel on the next read, while the agent's own
    // transcript and sidecar meta remain on disk as orphans. The meta still
    // names the spawning tool call, so the row is re-bound from it.
    //
    // Per decision: re-bound orphans read as `completed` — the run they were
    // part of is over and their timeline is all the evidence there is — and
    // they appear only in history reads (this pass), never in the live panel.
    const subagentsDirectory = path.join(projectDir, providerSessionId, 'subagents');
    try {
      const metaFiles = (await fsp.readdir(subagentsDirectory)).filter((name) => name.endsWith('.meta.json'));
      for (const metaFile of metaFiles) {
        const orphanAgentId = metaFile.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
        if (!orphanAgentId || agentIds.has(orphanAgentId)) {
          continue;
        }

        const orphanMeta = await readClaudeSubagentMeta(path.join(subagentsDirectory, metaFile));
        const orphanToolUseId = orphanMeta.toolUseId;
        if (!orphanToolUseId) {
          continue;
        }

        const spawnRow = messages.find((message) => Array.isArray(message.message?.content)
          && (message.message.content as AnyRecord[]).some(
            (part) => part?.type === 'tool_result' && part.tool_use_id === orphanToolUseId,
          ));
        if (!spawnRow || spawnRow.subagent) {
          continue;
        }

        const located = await findClaudeSubagentTranscript(projectDir, providerSessionId, orphanAgentId);
        const [orphanTranscript, orphanMetaRead] = located
          ? await Promise.all([
            readClaudeSubagentTranscript(located.transcriptPath),
            readClaudeSubagentMeta(located.metaPath),
          ])
          : [{ activity: [] as SubagentActivity[], endedMidToolCall: false, model: undefined }, {} as ClaudeSubagentMeta];

        spawnRow.subagent = {
          id: orphanAgentId,
          name: orphanMetaRead.agentType,
          type: orphanMetaRead.agentType,
          description: orphanMetaRead.description ?? orphanMetaRead.agentType,
          model: orphanTranscript.model,
          toolUseId: orphanToolUseId,
          // Only the history read assigns this status; the run they belonged to
          // is over, and no better evidence exists than the timeline itself.
          status: 'completed',
          activityCount: orphanTranscript.activity.length,
        };
        spawnRow.subagentTools = orphanTranscript.activity
          .slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
          .map(truncateSubagentActivity);
      }
    } catch {
      // No subagents directory (or an unreadable one) means no orphans — the
      // normal case for sessions that never spawned one.
    }

    const sortedMessages = messages
      .filter((message) => !foldedNotificationUuids.has(String(message.uuid ?? '')))
      .sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 *
 * Skill bodies belong in the first group. When a skill is invoked, Claude
 * injects the entire SKILL.md as a synthetic user turn. Persisted transcripts
 * tag it `isMeta: true`, but the live SDK stream does not, so without a
 * content-level check the same payload renders as a huge user bubble during the
 * run and then vanishes on reload. The skill is already represented by the
 * `Skill` tool call, so it is never user-visible content.
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  'Base directory for this skill:',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   *
   * Every user turn it produces is stamped with the transcript row's `uuid`,
   * which is the anchor "edit this message" and "fork from here" address. It is
   * applied here rather than at each `createNormalizedMessage` call because the
   * row-shape branches below have several exits, and an anchor missing from one
   * of them would show up as a message the user silently cannot edit.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const messages = this.normalizeMessageRows(rawMessage, sessionId);
    // A synthesized id is useless as an anchor — it changes on every read — so
    // a row without its own uuid produces messages with no anchor at all.
    const raw = readObjectRecord(rawMessage);
    const anchorId = typeof raw?.uuid === 'string' && raw.uuid ? raw.uuid : null;
    if (anchorId) {
      for (const message of messages) {
        if (message.role === 'user') {
          message.transcriptAnchorId = anchorId;
        }
      }
    }

    return messages;
  }

  private normalizeMessageRows(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    // Partial events, when the runtime asks the CLI for them. Each one is either a
    // bare raw event or one wrapped in a `stream_event` envelope — which of the two
    // arrives is the CLI's choice, not this side's, so both are read. Guessing wrong
    // does not fail loudly: it just stops streaming, which is the one symptom nobody
    // can see from a test that only exercises one shape.
    const streamEvent = raw.type === 'stream_event' ? readObjectRecord(raw.event) : raw;
    if (streamEvent?.type === 'content_block_delta') {
      const delta = readObjectRecord(streamEvent.delta);
      if (typeof delta?.text === 'string') {
        return [createNormalizedMessage({ kind: 'stream_delta', content: delta.text, sessionId, provider: PROVIDER })];
      }
      // Reasoning is a separate stream from the answer, and is kept separate here.
      // Sharing `stream_delta` would append thinking to the answer as it is written,
      // and the completed thinking block would then arrive as a second copy of it.
      if (typeof delta?.thinking === 'string') {
        return [createNormalizedMessage({ kind: 'thinking_delta', content: delta.thinking, sessionId, provider: PROVIDER })];
      }
      // Anything else is a stream this side has no row for — tool arguments arrive
      // as `input_json_delta`, and the call itself is reported separately.
      return [];
    }
    if (streamEvent?.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    // A compaction is the most expensive thing a long session does without
    // being asked, and neither record that describes it survives the branches
    // below: `system` events normalize to nothing. Both become one ordinary
    // assistant row, so a client that knows nothing of `compact` still reads
    // the sentence, while one that does can draw it as a row of its own.
    if (raw.type === 'system' && (raw.subtype === 'compact_boundary' || raw.subtype === 'status')) {
      const compactionRow = (content: string, compact: CompactionInfo): NormalizedMessage[] => [
        createNormalizedMessage({
          id: `${baseId}_compact`,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content,
          compact,
        }),
      ];

      if (raw.subtype === 'compact_boundary') {
        // `compact_metadata` live, `compactMetadata` on disk.
        const metadata = readObjectRecord(raw.compact_metadata ?? raw.compactMetadata) ?? {};
        const trigger = metadata.trigger === 'manual' ? 'manual' : 'auto';
        const preTokens = Number(metadata.pre_tokens ?? metadata.preTokens) || 0;
        const postTokens = Number(metadata.post_tokens ?? metadata.postTokens) || 0;
        const durationMs = Number(metadata.duration_ms ?? metadata.durationMs) || 0;
        const said = ['Compacted', trigger];
        if (preTokens) {
          said.push(postTokens
            ? `${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)} tokens`
            : `${formatTokenCount(preTokens)} tokens`);
        }
        if (durationMs) {
          said.push(formatDuration(durationMs));
        }

        return compactionRow(said.join(' · '), {
          phase: 'done',
          trigger,
          preTokens,
          postTokens,
          durationMs,
        });
      }

      // A status message reports several things, and compaction is the only one
      // with anything to say: every other turn sends `requesting` or nothing.
      if (raw.status === 'compacting') {
        return compactionRow('Compacting conversation…', { phase: 'running' });
      }
      if (raw.compact_result === 'failed') {
        const error = typeof raw.compact_error === 'string' ? raw.compact_error : null;
        return compactionRow(`Compaction failed${error ? `: ${error}` : ''}`, {
          phase: 'failed',
          error,
        });
      }

      return [];
    }

    // A spawned agent's live lifecycle. Nothing else in the stream reports it:
    // the JSONL transcript only records the agent's finished sidechain, and the
    // spawning tool call returns long before a backgrounded agent is done.
    if (raw.type === 'system') {
      const taskUpdate = normalizeClaudeTaskEvent(raw, sessionId, baseId, ts);
      if (taskUpdate) {
        return taskUpdate;
      }
    }

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      if (Array.isArray(raw.message.content)) {
        // Image attachments sent through the SDK are persisted as base64
        // `image` blocks next to the prompt text. Collect them so the UI can
        // render them on the user bubble.
        const imageAttachments: Array<{ data: string }> = [];
        for (const part of raw.message.content) {
          if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
            const mediaType = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
            imageAttachments.push({ data: `data:${mediaType};base64,${part.source.data}` });
          }
        }
        let imagesAttached = false;
        let filesAttached = false;

        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            const parsedFiles = parseFilesInputTag(text);
            if (
              (parsedFiles.text || parsedFiles.attachments.length > 0)
              && !isInternalContent(parsedFiles.text)
            ) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: parsedFiles.text,
                images: !imagesAttached && imageAttachments.length > 0 ? imageAttachments : undefined,
                files: !filesAttached && parsedFiles.attachments.length > 0
                  ? parsedFiles.attachments
                  : undefined,
              }));
              imagesAttached = true;
              filesAttached = filesAttached || parsedFiles.attachments.length > 0;
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
            }));
            imagesAttached = true;
          }
        }

        // Image-only turns still deserve a user bubble even without text.
        if (!imagesAttached && imageAttachments.length > 0) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_images`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: imageAttachments,
          }));
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiSequences(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        const parsedFiles = parseFilesInputTag(text);
        if (
          (parsedFiles.text || parsedFiles.attachments.length > 0)
          && !isInternalContent(parsedFiles.text)
        ) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: parsedFiles.text,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Finds the row to resume *through* so that `anchorId`'s turn is replaced.
   *
   * Walks up the `parentUuid` chain to the nearest assistant row, because the
   * SDK's `resumeSessionAt` is documented against assistant message ids — the
   * user row's immediate parent can be an attachment or an injected note.
   * Returns `null` when nothing precedes the edited prompt, which means the
   * conversation should start over rather than resume.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }> {
    const session = sessionsDb.getSessionById(sessionId);
    const jsonlPath = session?.jsonl_path;
    const providerSessionId = session?.provider_session_id;
    if (!jsonlPath || !providerSessionId) {
      return { found: false, resumeThroughId: null };
    }

    const rows = await readTranscriptRows(jsonlPath, providerSessionId);
    const byUuid = new Map<string, AnyRecord>();
    for (const row of rows) {
      if (typeof row.uuid === 'string') {
        byUuid.set(row.uuid, row);
      }
    }

    const target = byUuid.get(anchorId);
    if (!target) {
      return { found: false, resumeThroughId: null };
    }

    const visited = new Set<string>([anchorId]);
    let parentUuid: unknown = target.parentUuid;
    while (typeof parentUuid === 'string' && !visited.has(parentUuid)) {
      visited.add(parentUuid);
      const parent = byUuid.get(parentUuid);
      if (!parent) {
        break;
      }
      if (parent.type === 'assistant') {
        return { found: true, resumeThroughId: parentUuid };
      }
      parentUuid = parent.parentUuid;
    }

    return { found: true, resumeThroughId: null };
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, providerSessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              subagent: raw.subagent,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
        msg.subagent = toolResult.subagent;
      }
    }

    // Everything the transcript draws, and nothing else — so a page of N rows
    // is N rows the user sees, and `total` counts the same thing.
    const transcript = prepareTranscriptMessages(normalized);
    const total = transcript.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(transcript, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      // Carried on every page, like the Codex and OpenCode readers do, so the
      // composer's counter tracks the conversation instead of being frozen at
      // whatever it was when the session was opened.
      tokenUsage: summarizeClaudeTokenUsage(rawMessages),
    };
  }

  /**
   * One spawned agent's transcript, read on demand and uncapped.
   *
   * `getSessionMessages` already reads every agent's transcript, but it caps what it hangs
   * off the parent's rows — `MAX_TRANSMITTED_SUBAGENT_ACTIVITIES` entries, each truncated —
   * because those rows travel with every history page. A reader asking to see one agent in
   * full is asking for the file, so this reads it again rather than serving the capped copy.
   */
  async fetchSubagentTranscript(
    sessionId: string,
    agentId: string,
    options: FetchHistoryOptions = {},
  ): Promise<SubagentActivity[] | null> {
    const session = sessionsDb.getSessionById(sessionId);
    const jsonLPath = session?.jsonl_path;
    const providerSessionId = options.providerSessionId ?? session?.provider_session_id;
    if (!jsonLPath || !providerSessionId || !agentId) {
      return null;
    }

    // Resolved the same way `getSessionMessages` resolves it, from the parent transcript's
    // own directory, so both agree on where an agent lives.
    const located = await findClaudeSubagentTranscript(
      path.dirname(jsonLPath),
      providerSessionId,
      agentId,
    );
    if (!located) {
      return null;
    }

    const transcript = await readClaudeSubagentTranscript(located.transcriptPath);
    return transcript.activity;
  }
}
