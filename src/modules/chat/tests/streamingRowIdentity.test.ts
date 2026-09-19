import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

/**
 * The transcript keys a row by `getIntrinsicMessageKey`, and that function wants an id
 * first. When a row has none it falls back to a key built from the row's timestamp and the
 * first 48 characters of its content.
 *
 * A live row moves both on every stream tick, because `updateStreaming` writes the
 * accumulated text and a fresh timestamp into the same row id ten times a second. So the
 * row was handed a new key, and React remounted it, on every tick. Inside the reasoning
 * disclosure that is not merely wasted work: the open state lives in the row, and a
 * remount re-derives it from `defaultOpen ?? isStreaming` — which is *open* while the
 * reasoning streams. A reader could therefore open the block but never shut it; the next
 * tick re-opened what they had just closed, too fast to see.
 *
 * These pin the identity. It fails silently rather than loudly: nothing throws, rows simply
 * stop keeping their own state, and the only visible symptom is far from the cause.
 */

const liveThinkingRow = (content: string, timestamp: string): NormalizedMessage => ({
  id: '__thinking_session-1',
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'thinking',
  content,
});

const keyOf = (row: NormalizedMessage): string | null => {
  const [message] = normalizedToChatMessages([row]);
  return getIntrinsicMessageKey(message);
};

test('a live row keeps its key while it is rewritten', () => {
  const first = keyOf(liveThinkingRow('weighing the two options', '2026-09-19T12:00:00.000Z'));
  const grown = keyOf(liveThinkingRow('weighing the two options, and then some more', '2026-09-19T12:00:00.100Z'));

  assert.equal(grown, first, 'a row rewritten in place must not be remounted under the reader');
});

test('a live answer row keeps its key too', () => {
  // The answer travels under its own kind — `stream_delta` while live, `text` once settled
  // — so it is projected by a different branch, and the branch that draws it is the one
  // most easily missed when identity is fixed.
  const liveRow = (content: string, timestamp: string): NormalizedMessage => ({
    id: '__streaming_session-1',
    sessionId: 'session-1',
    timestamp,
    provider: 'claude',
    kind: 'stream_delta',
    content,
  });

  const first = keyOf(liveRow('the first half', '2026-09-19T12:00:00.000Z'));
  const grown = keyOf(liveRow('the first half of the answer', '2026-09-19T12:00:00.100Z'));

  assert.equal(grown, first, 'a row rewritten in place must not be remounted under the reader');
});

test('a live reasoning row and a live answer row are told apart', () => {
  // Same tick, same timestamp, same accumulated text — the two channels are flushed
  // together, so anything derived from those three fields gives them one key between them.
  const timestamp = '2026-09-19T12:00:00.000Z';
  const thinking = keyOf(liveThinkingRow('weighing the two options', timestamp));
  const answer = keyOf({
    id: '__streaming_session-1',
    sessionId: 'session-1',
    timestamp,
    provider: 'claude',
    kind: 'stream_delta',
    content: 'weighing the two options',
  });

  assert.notEqual(answer, thinking, 'two live rows must not collide on one key');
});

test('each settled block is its own row', () => {
  const first = keyOf({ ...liveThinkingRow('block one', '2026-09-19T12:00:01.000Z'), id: 'thinking_1758_a' });
  const second = keyOf({ ...liveThinkingRow('block two', '2026-09-19T12:00:02.000Z'), id: 'thinking_1758_b' });

  assert.notEqual(second, first);
});
