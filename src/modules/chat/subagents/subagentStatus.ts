import { CircleAlert, CircleCheck, CircleSlash, LoaderCircle, type LucideIcon } from 'lucide-react';

import type { SubagentInfo, SubagentStatus, ToolResult } from '@/shared/types';

/**
 * How each subagent lifecycle state is drawn: the wording, the text colour and
 * the mark beside it.
 *
 * Shared by the transcript card and the subagent list so the same agent is
 * never described two different ways depending on where the reader is looking.
 * A `running` agent is drawn with a pulsing dot rather than this icon, which is
 * what keeps a live agent visibly different from a settled one.
 */
export const SUBAGENT_STATUS_PRESENTATION: Record<SubagentStatus, {
  label: string;
  className: string;
  Icon: LucideIcon;
}> = {
  running: {
    label: 'running',
    className: 'text-purple-600 dark:text-purple-300',
    Icon: LoaderCircle,
  },
  completed: {
    label: 'done',
    className: 'text-muted-foreground',
    Icon: CircleCheck,
  },
  failed: {
    label: 'failed',
    className: 'text-red-600 dark:text-red-400',
    Icon: CircleAlert,
  },
  // Deliberately not styled as an error: a cancelled agent is not a broken one.
  stopped: {
    label: 'stopped',
    className: 'text-muted-foreground',
    Icon: CircleSlash,
  },
};

/** True while a subagent is still expected to produce more work. */
export function isSubagentActive(status: SubagentStatus) {
  return status === 'running';
}

/**
 * Decides which lifecycle state an agent card reports.
 *
 * The provider's own task status wins whenever there is one — it is the only
 * thing that knows a *backgrounded* agent is still going. Without it the card
 * has to infer, and the one inference that must not be made is completion: an
 * async agent's launch acknowledgement comes back the moment the agent is
 * admitted, so reading the presence of any result as completion is what made a
 * still-running agent render as finished.
 */
export function resolveSubagentStatus(
  reported: SubagentInfo['status'] | undefined,
  toolResult: ToolResult | null | undefined,
): SubagentStatus {
  if (reported) {
    return reported;
  }

  const launchedAsync = Boolean(
    (toolResult?.toolUseResult as { isAsync?: boolean } | undefined)?.isAsync,
  );

  return toolResult && !launchedAsync ? 'completed' : 'running';
}
