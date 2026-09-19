import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { SubagentActivity, SubagentInfo } from '@/shared/types';

type SubagentStateForSession = {
  /** The session this state describes. State carrying another one is not this session's. */
  sessionKey: string | null;
  subagents: SubagentInfo[];
  activityByAgent: Record<string, SubagentActivity[]>;
  loadingAgentIds: string[];
  /** Agents already asked about, so opening and closing a row does not re-ask. */
  requestedAgentIds: string[];
};

type SessionSubagentState = {
  /** Every agent the session spawned, whether or not the row that spawned it is loaded. */
  subagents: SubagentInfo[];
  /** Full timelines, by agent id, for the rows the reader has opened. */
  activityByAgent: Record<string, SubagentActivity[]>;
  /** Agent ids whose timeline is in flight, so a row can say so instead of looking dead. */
  loadingAgentIds: string[];
  /** Fetches one agent's full timeline, once per agent per session. */
  loadActivity: (agentId: string) => void;
};

const NOTHING_LOADED: SubagentStateForSession = {
  sessionKey: null,
  subagents: [],
  activityByAgent: {},
  loadingAgentIds: [],
  requestedAgentIds: [],
};

/**
 * The viewed session's subagents, read from their own endpoint rather than off whichever
 * slice of the transcript the client has loaded.
 *
 * The transcript is paged, and the panel that draws these agents derived them from the
 * loaded pages — so an agent disappeared as soon as the page holding its spawn row was not
 * loaded, which in a long conversation is most of them. The list endpoint asks the reader
 * for the whole conversation and returns only the agents in it, so the list is complete
 * regardless of paging and the panel no longer has to care how much history is in memory.
 *
 * One agent's timeline is deliberately not part of that read. It is the largest thing the
 * backend can return for a session, a reader usually wants the list rather than every tool
 * call of every agent, and shipping it with each page would cost more than it shows.
 * `loadActivity` fetches it when a row is opened, and the result is kept, so reopening a
 * row does not ask twice.
 */
export function useSessionSubagents(sessionId: string | null | undefined): SessionSubagentState {
  const sessionKey = sessionId ?? null;
  const [state, setState] = useState<SubagentStateForSession>(NOTHING_LOADED);

  // Derived rather than reset: state tagged with the previous session is not this session's
  // answer, and saying so during render is what keeps a session switch from drawing the
  // outgoing session's agents against the incoming one.
  const current = state.sessionKey === sessionKey ? state : NOTHING_LOADED;

  /** Applies an update to this session's slice, starting one when there is none yet. */
  const update = useCallback((
    updater: (existing: SubagentStateForSession) => SubagentStateForSession,
  ) => {
    setState((existing) => updater(
      existing.sessionKey === sessionKey ? existing : { ...NOTHING_LOADED, sessionKey },
    ));
  }, [sessionKey]);

  useEffect(() => {
    if (!sessionKey) {
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await api.providers.sessionSubagents(sessionKey);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = await response.json();
        const list = body?.data?.subagents;
        if (!cancelled) {
          update((existing) => ({
            ...existing,
            subagents: Array.isArray(list) ? list : [],
          }));
        }
      } catch (error) {
        // Deliberately quiet. The loaded transcript still carries a summary for every agent
        // in it, so a failed list read degrades to what the panel showed before this endpoint
        // existed, rather than to an error the reader cannot act on.
        console.warn('Failed to load session subagents:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionKey, update]);

  const loadActivity = useCallback((agentId: string) => {
    if (!sessionKey || !agentId || current.requestedAgentIds.includes(agentId)) {
      return;
    }

    update((existing) => ({
      ...existing,
      requestedAgentIds: existing.requestedAgentIds.includes(agentId)
        ? existing.requestedAgentIds
        : [...existing.requestedAgentIds, agentId],
      loadingAgentIds: existing.loadingAgentIds.includes(agentId)
        ? existing.loadingAgentIds
        : [...existing.loadingAgentIds, agentId],
    }));

    void (async () => {
      try {
        const response = await api.providers.sessionSubagentTranscript(sessionKey, agentId);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = await response.json();
        const activity = body?.data?.activity;
        update((existing) => ({
          ...existing,
          activityByAgent: {
            ...existing.activityByAgent,
            [agentId]: Array.isArray(activity) ? activity : [],
          },
        }));
      } catch (error) {
        // Cached as empty so the row stops claiming to be loading. Some providers keep no
        // per-agent transcript at all, which is an answer rather than a failure.
        console.warn('Failed to load subagent transcript:', error);
        update((existing) => ({
          ...existing,
          activityByAgent: { ...existing.activityByAgent, [agentId]: [] },
        }));
      } finally {
        update((existing) => ({
          ...existing,
          loadingAgentIds: existing.loadingAgentIds.filter((id) => id !== agentId),
        }));
      }
    })();
  }, [sessionKey, current.requestedAgentIds, update]);

  return {
    subagents: current.subagents,
    activityByAgent: current.activityByAgent,
    loadingAgentIds: current.loadingAgentIds,
    loadActivity,
  };
}
