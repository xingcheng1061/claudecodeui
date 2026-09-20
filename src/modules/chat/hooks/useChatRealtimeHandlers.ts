import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage } from '@/shared/types';
import { hydrateChatDrafts } from '@/shared/chatDrafts';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

/**
 * How long streaming increments are buffered before their row is rewritten.
 *
 * Each flush replaces a whole row, so it costs a store update and a React commit —
 * batching is what keeps a long answer from committing once per token.
 */
const STREAM_FLUSH_MS = 100;

/**
 * Writes the answer and reasoning rows from their accumulators.
 *
 * Both channels are written together. They arrive on one stream and are buffered on
 * one tick, so flushing them apart would let a tick land on the answer while the
 * reasoning that produced it was still sitting in a buffer — and the two would swap
 * places on screen.
 *
 * Takes everything it needs as arguments rather than closing over it, because this
 * runs on the hot path: a fresh closure per frame to capture the same values is work
 * the batching above exists to avoid.
 */
function flushStreamRows({
  sessionId,
  provider,
  sessionStore,
  accumulatedStreamRef,
  accumulatedThinkingRef,
}: {
  sessionId: string | null;
  provider: LLMProvider;
  sessionStore: SessionStore;
  accumulatedStreamRef: MutableRefObject<Map<string, string>>;
  accumulatedThinkingRef: MutableRefObject<Map<string, string>>;
}): void {
  // `null` flushes every bucket: the shared timer cannot know which session's
  // increments arrived this tick, and a background session's row must refresh
  // on the same tick as the viewed one's.
  const buckets = sessionId
    ? [sessionId]
    : [...new Set([...accumulatedStreamRef.current.keys(), ...accumulatedThinkingRef.current.keys()])];

  for (const bucketSessionId of buckets) {
    const answer = accumulatedStreamRef.current.get(bucketSessionId);
    if (answer) {
      sessionStore.updateStreaming(bucketSessionId, answer, provider);
    }
    const thinking = accumulatedThinkingRef.current.get(bucketSessionId);
    if (thinking) {
      sessionStore.updateStreaming(bucketSessionId, thinking, provider, 'thinking');
    }
  }
}

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamTimerRef: MutableRefObject<number | null>;
  /**
   * Live answer increments, one bucket per session id. Buckets keep concurrent
   * runs apart: one shared string let two sessions' deltas (and a subagent's)
   * interleave into a single row, each flush painting the mixture onto
   * whichever session happened to trigger it.
   */
  accumulatedStreamRef: MutableRefObject<Map<string, string>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Reasoning accumulates apart from the answer: same stream, its own row, its
  // own bucket per session. Local rather than a prop, because nothing outside
  // this hook reads it.
  const accumulatedThinkingRef = useRef(new Map<string, string>());

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'queued-updated': {
          // The server changed a session's queue (an injected message was
          // claimed, another device sent one). Re-pull the drafts so the
          // composer's queued card agrees with the server in the same frame —
          // the card's own 5s poll would get there eventually, but an explicit
          // user action deserves immediate feedback.
          void hydrateChatDrafts();
          return;
        }

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'thinking_delta' || msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        // Bucketed strictly by the frame's own session id: a delta with no id
        // belongs to no row we can name, and writing it to the viewed session
        // would be the cross-session bleed the buckets exist to prevent.
        const bucketSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
        // Subagent partials are never rendered: the folding loop in
        // useChatMessages skips every row carrying the parent stamp, and the
        // live display comes from the forwarded complete blocks. Buffering
        // them would interleave an agent's words into the main thread's row.
        if (!text || !bucketSessionId || msg.parentToolUseId) return;

        const bucket = msg.kind === 'thinking_delta'
          ? accumulatedThinkingRef.current
          : accumulatedStreamRef.current;
        bucket.set(bucketSessionId, (bucket.get(bucketSessionId) ?? '') + text);
        if (!streamTimerRef.current) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            // Flush every bucket: whichever session's increments arrived this
            // tick, the others' rows must not wait for their next delta.
            flushStreamRows({ sessionId: null, provider, sessionStore, accumulatedStreamRef, accumulatedThinkingRef });
          }, STREAM_FLUSH_MS);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        // Only this session's rows end: a subagent's block stopping must not cut
        // the main thread's stream short, and another session's must not cut
        // this one's.
        const bucketSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
        if (!bucketSessionId || msg.parentToolUseId) {
          return;
        }
        flushStreamRows({ sessionId: bucketSessionId, provider, sessionStore, accumulatedStreamRef, accumulatedThinkingRef });
        // Renames both rows, so the next turn's increments start a new one instead
        // of rewriting this turn's. Called even when nothing was buffered: a row
        // left over from an interrupted stream is still a row.
        sessionStore.finalizeStreaming(bucketSessionId);
        sessionStore.finalizeStreaming(bucketSessionId, 'thinking');
        accumulatedStreamRef.current.delete(bucketSessionId);
        accumulatedThinkingRef.current.delete(bucketSessionId);
        // The single timer flushes every bucket; retire it only when no other
        // session still has increments pending.
        if (accumulatedStreamRef.current.size === 0
          && accumulatedThinkingRef.current.size === 0
          && streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state — this session's rows only;
          // other sessions' buckets are theirs to finish.
          if (sid) {
            flushStreamRows({ sessionId: sid, provider, sessionStore, accumulatedStreamRef, accumulatedThinkingRef });
            sessionStore.finalizeStreaming(sid);
            sessionStore.finalizeStreaming(sid, 'thinking');
            accumulatedStreamRef.current.delete(sid);
            accumulatedThinkingRef.current.delete(sid);
          }
          if (accumulatedStreamRef.current.size === 0
            && accumulatedThinkingRef.current.size === 0
            && streamTimerRef.current) {
            clearTimeout(streamTimerRef.current);
            streamTimerRef.current = null;
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
