import assert from 'node:assert/strict';
import test from 'node:test';

import {
  learnContextWindow,
  learnContextWindowsFromResult,
  resolveContextWindow
} from '@/modules/providers/shared/context-window.js';

/**
 * The context window is the denominator of every "N% used" display. This
 * module learns it per model from each turn's `result.modelUsage`, because
 * neither the SDK's model info nor the transcript's cost-state rows carry one —
 * and a 1M-window model read against the 160k default looks permanently
 * nearly-full.
 *
 * The cache is module state, so tests that learn windows run after the ones
 * that assert the empty-cache fallback.
 */

test('resolves to the default when nothing is configured or learned', () => {
  const previous = process.env.CONTEXT_WINDOW;
  delete process.env.CONTEXT_WINDOW;
  try {
    assert.equal(resolveContextWindow('claude-opus-4-6'), 160_000);
    assert.equal(resolveContextWindow(), 160_000);
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_WINDOW;
    } else {
      process.env.CONTEXT_WINDOW = previous;
    }
  }
});

test('an explicit CONTEXT_WINDOW wins over anything learned', () => {
  const previous = process.env.CONTEXT_WINDOW;
  process.env.CONTEXT_WINDOW = '200000';
  try {
    learnContextWindow('claude-opus-4-6', 1_000_000);
    assert.equal(resolveContextWindow('claude-opus-4-6'), 200_000);
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_WINDOW;
    } else {
      process.env.CONTEXT_WINDOW = previous;
    }
  }
});

test('a learned window serves its model, and the no-model chains after it', () => {
  const previous = process.env.CONTEXT_WINDOW;
  delete process.env.CONTEXT_WINDOW;
  try {
    learnContextWindow('claude-sonnet-4-5', 1_000_000);

    assert.equal(resolveContextWindow('claude-sonnet-4-5'), 1_000_000);
    // Unknown model, and no model at all: the most recent learning stands in.
    assert.equal(resolveContextWindow('claude-opus-4-6'), 1_000_000);
    assert.equal(resolveContextWindow(), 1_000_000);
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_WINDOW;
    } else {
      process.env.CONTEXT_WINDOW = previous;
    }
  }
});

test('implausible learnings are rejected, not cached', () => {
  assert.equal(learnContextWindow('', 1_000_000), false);
  assert.equal(learnContextWindow(null, 1_000_000), false);
  assert.equal(learnContextWindow('claude-haiku-4-5', Number.NaN), false);
  assert.equal(learnContextWindow('claude-haiku-4-5', 'garbage'), false);
  assert.equal(learnContextWindow('claude-haiku-4-5', 12), false);
});

test('every modelUsage entry of a result is learned, and junk is a no-op', () => {
  const previous = process.env.CONTEXT_WINDOW;
  delete process.env.CONTEXT_WINDOW;
  try {
    learnContextWindowsFromResult({
      type: 'result',
      modelUsage: {
        'claude-opus-4-6[1m]': { contextWindow: 1_000_000 },
        'claude-haiku-4-5': { contextWindow: 200_000 },
      },
    });
    assert.equal(resolveContextWindow('claude-opus-4-6[1m]'), 1_000_000);
    assert.equal(resolveContextWindow('claude-haiku-4-5'), 200_000);

    // A result without modelUsage, or not a message at all: silent no-op.
    learnContextWindowsFromResult({ type: 'result' });
    learnContextWindowsFromResult(null);
    learnContextWindowsFromResult('result');
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_WINDOW;
    } else {
      process.env.CONTEXT_WINDOW = previous;
    }
  }
});
