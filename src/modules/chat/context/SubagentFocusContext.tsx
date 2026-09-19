import { createContext, useContext } from 'react';

export type SubagentFocusContextValue = {
  /** The subagent the user asked to see, named by the tool call that spawned it, or null when none is focused. */
  focusedToolUseId: string | null;
  /**
   * Bumped on every `focusSubagent` request, including a re-request of the agent that is
   * already focused. Consumers key their scroll effects on this rather than on
   * `focusedToolUseId`: an id that did not change would not re-run anything, and asking
   * again is exactly how a reader brings back a card they had collapsed.
   */
  focusToken: number;
  /**
   * Brings one subagent's card into view, expanding it first so its timeline is
   * what the reader lands on. Passing `null` releases the focus, which is how a
   * card lets the reader collapse the timeline it was forced open.
   */
  focusSubagent: (toolUseId: string | null) => void;
};

const SubagentFocusContext = createContext<SubagentFocusContextValue | null>(null);

/** Read by chat's SubagentPanel so the card the subagent list pointed at expands itself; null outside the provider. */
export function useSubagentFocus(): SubagentFocusContextValue | null {
  return useContext(SubagentFocusContext);
}

export default SubagentFocusContext;
