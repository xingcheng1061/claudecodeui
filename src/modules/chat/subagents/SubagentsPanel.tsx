import { memo, useMemo, useState } from 'react';
import { Bot, ChevronRight, CircleStop, Crosshair } from 'lucide-react';

import type { ChatMessage, SubagentActivity, SubagentInfo } from '@/shared/types';
import { cn } from '@/shared/utils';
import { formatSubagentUsageLabel } from '@/modules/chat/utils/chatFormatting';
import { useSubagentFocus } from '@/modules/chat/context/SubagentFocusContext';
import { mergeSubagentState } from '@/modules/chat/hooks/useChatMessages';
import { SUBAGENT_STATUS_PRESENTATION, isSubagentActive } from '@/modules/chat/subagents/subagentStatus';

type SubagentsPanelProps = {
  /**
   * The transcript's projected rows — the live half of each agent's state, and the only half
   * that moves while a turn runs. Not the list: see `subagents` for why.
   */
  messages: ChatMessage[];
  /**
   * Every agent this session spawned, from its own endpoint. That read asks the backend for
   * the whole conversation and returns only the agents in it, so this list is complete no
   * matter which pages of history the client happens to hold.
   */
  subagents?: SubagentInfo[];
  /** Full timelines, by agent id, for the rows the reader has opened. */
  activityByAgent?: Record<string, SubagentActivity[]>;
  /** Agent ids whose timeline is in flight. */
  loadingAgentIds?: string[];
  /** Fetches one agent's full timeline, on the first open of its row. */
  onLoadActivity?: (agentId: string) => void;
  /**
   * Loads the session's full history, for a jump whose card is not in the loaded window.
   * Without it, jumping from a row whose spawn row is on an unloaded page is a silent
   * no-op — that row does not exist in the client at all, so there is nothing to scroll to.
   */
  onLoadMissingCard?: () => void;
  /**
   * Stops one agent, named by the tool call that spawned it — the same key the rows
   * and the agent's own card are keyed by, so the two can never name different
   * agents. Absent on a surface with no way to send, which also hides the control.
   */
  onStopSubagent?: (toolUseId: string) => void;
};

type SubagentEntry = {
  /** The tool call that spawned the agent. Live updates and history reloads agree on it, so it is what the list keys on. */
  toolUseId: string;
  info: SubagentInfo;
  /**
   * The provider's id for the agent's own transcript, or null for an agent known only from
   * a live task event — those carry a task id, and only the history side has the agent id
   * the transcript is filed under.
   */
  transcriptId: string | null;
  /** What the transcript fold already knows, shown until, or instead of, a full read. */
  foldedActivity: SubagentActivity[];
};

/**
 * One line per activity entry.
 *
 * The panel is an index over the agents, not a second renderer for them: the transcript's
 * card is where an agent's work is drawn in full, and this is what a reader consults to find
 * out what an agent did without hunting for that card.
 */
const describeActivity = (item: SubagentActivity): { kind: string; detail: string } => {
  if (item.kind === 'tool') {
    const input = typeof item.toolInput === 'string' ? item.toolInput : JSON.stringify(item.toolInput ?? '');
    const detail = input && input !== '{}' ? `${item.toolName ?? 'Tool'} · ${input}` : item.toolName ?? 'Tool';
    return { kind: 'tool', detail };
  }

  return { kind: item.kind, detail: item.content ?? '' };
};

/**
 * How each timeline entry is dressed: a small kind chip, then the content. Kept
 * to three tints — reading an agent's timeline should be scanning, not admiring.
 */
const ACTIVITY_KIND_PRESENTATION: Record<string, { label: string; chip: string }> = {
  tool: { label: 'tool', chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-300' },
  thinking: { label: 'think', chip: 'bg-purple-500/10 text-purple-600 dark:text-purple-300' },
  text: { label: 'text', chip: 'bg-muted text-muted-foreground' },
};

/**
 * One row per subagent in the viewed session, pinned above the composer.
 *
 * The transcript already draws a card per agent, but only in place: reaching one
 * means scrolling back to the turn that spawned it, and a long transcript hides
 * it behind lazy rows. This list is an always-reachable index over the same
 * data: opening a row reads the agent's timeline in place, and the crosshair at
 * the row's right jumps to the agent's card in the transcript — kept apart, so
 * reading a timeline never costs a scroll and a scroll is never an accident.
 *
 * Rendered by chat's ChatInterface.
 */
export const SubagentsPanel = memo(({
  messages,
  subagents,
  activityByAgent,
  loadingAgentIds,
  onLoadActivity,
  onLoadMissingCard,
  onStopSubagent,
}: SubagentsPanelProps) => {
  const focus = useSubagentFocus();

  // The live half, by spawn row: what the loaded window knows. It is also the only place an
  // agent spawned mid-turn appears before the list endpoint has been re-read, and the test
  // for whether a jump's target exists in the client at all.
  const liveByToolUseId = useMemo(() => {
    const map = new Map<string, SubagentEntry>();
    for (const message of messages) {
      const info = message.subagent;
      const toolUseId = info?.toolUseId ?? message.toolId;
      if (!info || !toolUseId) {
        continue;
      }
      // Later rows win: the transcript is ordered, so the last row mentioning
      // an agent carries its most recent state.
      map.set(toolUseId, {
        toolUseId,
        info,
        transcriptId: null,
        foldedActivity: message.subagentActivity ?? [],
      });
    }
    return map;
  }, [messages]);

  const entries = useMemo(() => {
    // Worked on a copy: `liveByToolUseId` is memoized, and draining it here would silently
    // drop the live-only agents on the next pass that reuses it.
    const remainingLive = new Map(liveByToolUseId);

    // The list is the spine — it knows every agent the session ever spawned. The live rows
    // are then folded onto it, because identity and the summary survive a reload while the
    // status and usage only the live stream has do not.
    const byToolUseId = new Map<string, SubagentEntry>();
    for (const info of subagents ?? []) {
      const toolUseId = info.toolUseId;
      if (!toolUseId) {
        continue;
      }
      const live = remainingLive.get(toolUseId);
      remainingLive.delete(toolUseId);
      byToolUseId.set(toolUseId, {
        toolUseId,
        info: mergeSubagentState(info, live?.info) ?? info,
        transcriptId: info.id,
        foldedActivity: live?.foldedActivity ?? [],
      });
    }

    // What is left was spawned mid-turn and has not reached the list yet. A live task event
    // is then the only thing that knows about it, and dropping it would hide an agent the
    // reader can watch working in the transcript.
    for (const entry of remainingLive.values()) {
      byToolUseId.set(entry.toolUseId, entry);
    }

    return Array.from(byToolUseId.values());
  }, [subagents, liveByToolUseId]);

  const activeCount = entries.filter((entry) => isSubagentActive(entry.info.status)).length;

  // Open while work is in flight — a running agent is the one state worth
  // showing unasked — and collapsed otherwise. Once the reader decides for
  // themselves, that decision outranks the automatic default.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const isOpen = userOpen ?? activeCount > 0;

  // Per row, and only the rows that were opened: an agent's timeline is the largest read
  // the backend offers, and most visits are to the list.
  const [expandedRows, setExpandedRows] = useState<string[]>([]);

  if (entries.length === 0) {
    return null;
  }

  const toggleRow = (entry: SubagentEntry) => {
    const isExpanded = expandedRows.includes(entry.toolUseId);
    if (!isExpanded && entry.transcriptId) {
      onLoadActivity?.(entry.transcriptId);
    }
    setExpandedRows((ids) => (
      isExpanded ? ids.filter((id) => id !== entry.toolUseId) : [...ids, entry.toolUseId]
    ));
  };

  return (
    <div className="border-t border-border/50">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setUserOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('h-4 w-4 flex-shrink-0 transition-transform duration-150', isOpen && 'rotate-90')} />
        <Bot className="h-4 w-4 flex-shrink-0 text-purple-500 dark:text-purple-400" />
        <span className="font-medium text-foreground">
          {entries.length} {entries.length === 1 ? 'subagent' : 'subagents'}
        </span>
        {activeCount > 0 && (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-purple-600 dark:text-purple-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
            {activeCount} active
          </span>
        )}
      </button>

      {isOpen && (
        <div className="max-h-64 overflow-y-auto px-4 pb-2">
          {entries.map((entry) => {
            const { toolUseId, info, transcriptId } = entry;
            const presentation = SUBAGENT_STATUS_PRESENTATION[info.status];
            const usage = info.usage ? formatSubagentUsageLabel(info.usage) : '';
            const active = isSubagentActive(info.status);
            // The runtime decides this, never the list: an agent whose status was
            // read from the transcript only *looks* running, and has no handle
            // behind it for a stop to act on.
            const canStop = active && Boolean(info.canInterrupt) && Boolean(onStopSubagent);
            const isExpanded = expandedRows.includes(toolUseId);
            const isLoading = Boolean(transcriptId && loadingAgentIds?.includes(transcriptId));
            // A full read when there is one, the folded timeline otherwise — a running agent
            // has no transcript file to read yet, and an empty panel would be a lie.
            const activity = (transcriptId ? activityByAgent?.[transcriptId] : undefined)
              ?? entry.foldedActivity;

            return (
              // A row is not a single button: it holds an open control, a jump
              // target, and, while the agent is running, a stop control.
              // Nesting them would be invalid markup and would let one
              // mis-click stop an agent instead of opening it. Opening is what
              // the row body does — jumping is a deliberate, separately placed
              // act, so reading a timeline never costs a scroll.
              <div
                key={toolUseId}
                className="rounded-md transition-colors hover:bg-accent/60"
              >
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => toggleRow(entry)}
                    title={info.description || info.type || 'Subagent'}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-1 text-left text-sm"
                  >
                    <ChevronRight className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50 transition-transform duration-150', isExpanded && 'rotate-90')} />
                    {active ? (
                      <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
                    ) : (
                      <presentation.Icon className={cn('h-3.5 w-3.5 flex-shrink-0', presentation.className)} />
                    )}
                    <span className="flex-shrink-0 font-medium text-foreground">{info.type || 'Agent'}</span>
                    {info.description && (
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{info.description}</span>
                    )}
                    {usage && (
                      <span className="ml-auto flex-shrink-0 text-[11px] tabular-nums text-muted-foreground/60">{usage}</span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      focus?.focusSubagent(toolUseId);
                      // A jump whose card is not in the loaded window is otherwise a silent
                      // no-op: that row does not exist in the client at all, so there is
                      // nothing to scroll to. Ask for the whole transcript; the focus effect
                      // in the transcript pane scrolls once the row arrives.
                      if (!liveByToolUseId.has(toolUseId)) {
                        onLoadMissingCard?.();
                      }
                    }}
                    title="Jump to this agent's card in the transcript"
                    aria-label="Jump to this agent's card in the transcript"
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                  </button>

                  {canStop && (
                    <button
                      type="button"
                      onClick={() => onStopSubagent?.(toolUseId)}
                      title="Stop this subagent"
                      aria-label="Stop this subagent"
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <CircleStop className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {isExpanded && (
                  <div className="mb-1.5 ml-6 mr-1 overflow-hidden rounded-lg border border-border/40 bg-muted/30">
                    <div className="max-h-56 overflow-y-auto">
                      {isLoading ? (
                        <p className="px-3 py-2.5 text-xs text-muted-foreground/70">Loading transcript…</p>
                      ) : activity.length > 0 ? (
                        <ol className="divide-y divide-border/30">
                          {activity.map((item, index) => {
                            const { kind, detail } = describeActivity(item);
                            const presentation = ACTIVITY_KIND_PRESENTATION[kind]
                              ?? ACTIVITY_KIND_PRESENTATION.text;
                            return (
                              <li key={`${toolUseId}-${index}`} className="flex items-start gap-2 px-2.5 py-1.5">
                                <span
                                  className={cn(
                                    'mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                                    presentation.chip,
                                  )}
                                >
                                  {presentation.label}
                                </span>
                                <span
                                  className={cn(
                                    'min-w-0 flex-1 leading-relaxed',
                                    kind === 'tool'
                                      ? 'truncate font-mono text-[11px] text-muted-foreground'
                                      : 'whitespace-pre-wrap text-xs text-foreground/85',
                                    kind === 'thinking' && 'italic text-muted-foreground',
                                  )}
                                  title={kind === 'tool' ? detail : undefined}
                                >
                                  {detail}
                                </span>
                              </li>
                            );
                          })}
                        </ol>
                      ) : (
                        <p className="px-3 py-2.5 text-xs italic text-muted-foreground/60">
                          No transcript for this agent yet.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

SubagentsPanel.displayName = 'SubagentsPanel';
