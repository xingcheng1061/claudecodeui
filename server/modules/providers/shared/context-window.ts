/**
 * Learned context windows, per model.
 *
 * The denominator every "N% of the context window used" display divides by was
 * `process.env.CONTEXT_WINDOW || 160000` everywhere — but the CLI's model
 * catalogue carries models whose window is a million tokens, and for those the
 * default reads as permanently nearly-full. The SDK's model info does not carry
 * a window either; the only place one appears is each turn's
 * `result.modelUsage[<model>].contextWindow`, so that is what gets learned.
 *
 * A module of its own rather than a provider export because two chains need it
 * and neither owns the other: the realtime stream (the composer's counter) and
 * the transcript summary (the /cost popup). Sharing one cache is the point —
 * with separate caches the two displays would disagree.
 */

/** Fallback when nothing has been learned and nothing is configured. */
const DEFAULT_CONTEXT_WINDOW = 160_000;

/**
 * A learned window must plausibly be a token budget. The floor rejects empty
 * strings coerced through `Number()` and other garbage that would otherwise
 * poison the cache from one malformed result message.
 */
const MIN_PLAUSIBLE_WINDOW = 1_000;

const learnedContextWindows = new Map<string, number>();

/**
 * The most recently learned window, whatever model it belonged to. Serves the
 * chains that cannot name a model — a transcript cost-state row carries no
 * model at all — and for a conversation running one model, which is the
 * overwhelming case, that row's window is exactly this.
 */
let lastLearnedContextWindow: number | null = null;

function normalizeModelName(model: unknown): string | null {
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

function normalizeWindow(contextWindow: unknown): number | null {
  const window = typeof contextWindow === 'number' ? contextWindow : Number(contextWindow);
  return Number.isFinite(window) && window >= MIN_PLAUSIBLE_WINDOW ? Math.round(window) : null;
}

/**
 * Records a window seen for a model. Returns false for anything unusable —
 * a missing model name, a non-numeric or implausibly small window — so callers
 * that only report do not have to validate first.
 */
export function learnContextWindow(model: unknown, contextWindow: unknown): boolean {
  const name = normalizeModelName(model);
  const window = normalizeWindow(contextWindow);
  if (!name || window === null) {
    return false;
  }

  learnedContextWindows.set(name, window);
  lastLearnedContextWindow = window;
  return true;
}

/**
 * Learns every `modelUsage[<model>].contextWindow` a turn's `result` carries.
 * A turn may bill more than one model (main thread plus subagents), so this
 * accepts the whole record rather than one entry.
 *
 * No-op on anything that is not a result-shaped message, so the run loop can
 * call it unconditionally.
 */
export function learnContextWindowsFromResult(result: unknown): void {
  if (!result || typeof result !== 'object') {
    return;
  }

  const modelUsage = (result as Record<string, unknown>).modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return;
  }

  for (const [model, usage] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!usage || typeof usage !== 'object') {
      continue;
    }

    const contextWindow = (usage as Record<string, unknown>).contextWindow;
    if (contextWindow !== undefined) {
      learnContextWindow(model, contextWindow);
    }
  }
}

/**
 * Resolves the context window to divide by.
 *
 * Order of authority: an explicit `CONTEXT_WINDOW` wins — the operator set it
 * on purpose; then what was learned for this exact model; then the most
 * recently learned window (the no-model chains); then the historical default.
 */
export function resolveContextWindow(model?: unknown): number {
  const configured = Number.parseInt(process.env.CONTEXT_WINDOW ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  const name = normalizeModelName(model);
  if (name && learnedContextWindows.has(name)) {
    return learnedContextWindows.get(name)!;
  }

  if (lastLearnedContextWindow !== null) {
    return lastLearnedContextWindow;
  }

  return DEFAULT_CONTEXT_WINDOW;
}
