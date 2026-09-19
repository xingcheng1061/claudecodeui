import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { dedupeAdjacentAssistantEchoes, isStreamingRow } from '@/modules/chat/hooks/useSessionStore';

/**
 * Reasoning reaches the client two ways: incrementally while it is being thought, and
 * once more as a completed block inside the assistant message. The first is what makes
 * the reasoning visible while it happens; the second is what the transcript keeps.
 *
 * The live row is written under a well-known id and replaced on every flush, and it
 * carries `thinking` as its kind from the first increment — so it is not distinguishable
 * from the completed block by shape, only by having arrived first. These tests pin both
 * halves: that the live row projects into collapsible reasoning, and that the pair is
 * collapsed once the completed block lands.
 */

/** A streaming reasoning row, shaped as the store writes it mid-answer. */
function liveThinkingRow(id: string, content: string): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    timestamp: '2026-09-19T12:00:00.000Z',
    provider: 'claude',
    kind: 'thinking',
    content,
  };
}

test('a streaming reasoning row renders as collapsible thinking', () => {
  const [message] = normalizedToChatMessages([
    liveThinkingRow('__thinking_session-1', 'weighing the options'),
  ]);

  assert.equal(message.type, 'assistant');
  assert.equal(message.isThinking, true, 'this flag is what draws it as reasoning');
  assert.equal(message.content, 'weighing the options');
});

test('a reasoning row still being written reports itself as streaming', () => {
  // This flag is what holds the block open while the reasoning is produced, and what
  // closes it once it settles. Without it the reasoning is in the transcript but drawn
  // shut — which the reader cannot tell apart from it not being shown at all.
  const [live] = normalizedToChatMessages([
    liveThinkingRow('__thinking_session-1', 'weighing the options'),
  ]);
  assert.equal(live.isStreaming, true);

  const [settled] = normalizedToChatMessages([
    liveThinkingRow('thinking_1758_ab12cd', 'weighing the options'),
  ]);
  assert.equal(settled.isStreaming, false, 'a settled row must not claim to be streaming');
});

test('the streaming prefixes name exactly the rows a channel is still writing', () => {
  // The predicate and the ids the store writes have to agree; if they drift, live
  // reasoning silently renders shut rather than failing.
  assert.equal(isStreamingRow({ id: '__streaming_session-1' }), true);
  assert.equal(isStreamingRow({ id: '__thinking_session-1' }), true);
  assert.equal(isStreamingRow({ id: 'thinking_1758_ab12cd' }), false);
  assert.equal(isStreamingRow({}), false);
});

test('a reasoning row and the completed block behind it collapse into one', () => {
  // Both rows are kind `thinking` with the same text — the live one has no separate
  // placeholder kind to be recognised by, so the content is what pairs them.
  const merged = dedupeAdjacentAssistantEchoes([
    liveThinkingRow('thinking_1', 'weighing the options'),
    { ...liveThinkingRow('completed_1', 'weighing the options'), role: 'assistant' },
  ]);

  assert.equal(merged.length, 1, 'otherwise the reader sees the same reasoning twice');
  assert.equal(merged[0].id, 'completed_1', 'the completed row is the one kept');
});

test('reasoning that differs from the completed block is left as two rows', () => {
  // A mismatch means the live row is not the echo of this block, and silently dropping
  // it would lose reasoning rather than a duplicate.
  const merged = dedupeAdjacentAssistantEchoes([
    liveThinkingRow('thinking_1', 'weighing the options'),
    { ...liveThinkingRow('completed_1', 'weighing the options, and then some'), role: 'assistant' },
  ]);

  assert.equal(merged.length, 2);
});

test('an answer repeating the reasoning verbatim stays two rows', () => {
  // The pairing is within a kind: an answer that happens to match the reasoning is a
  // different thing to the reader, and the two collapse separately.
  const merged = dedupeAdjacentAssistantEchoes([
    liveThinkingRow('thinking_1', 'same wording'),
    { ...liveThinkingRow('text_1', 'same wording'), kind: 'text', role: 'assistant' },
  ]);

  assert.equal(merged.length, 2);
});
