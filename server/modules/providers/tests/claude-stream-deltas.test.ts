import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

/**
 * A turn reaches the client twice over: once as it is written, and once complete.
 * The first of those only exists when the runtime asks the CLI for partial events,
 * and the shape it arrives in is the CLI's choice — a bare raw event, or one wrapped
 * in a `stream_event` envelope.
 *
 * Both shapes are pinned here because getting this wrong fails silently. Nothing
 * throws, no row is malformed; the stream simply stops incrementing, and the only
 * visible symptom is the spinner that was already there before any of this existed.
 *
 * Reasoning is a third case again: it streams on the same channel as the answer but
 * is not the answer, so it is deliberately given its own kind rather than sharing
 * `stream_delta`. Folded in, it would be drawn as something the model said.
 */

const SESSION_ID = 'claude-session-1';

/** Drives the provider's normalizer the way the live SDK stream does. */
function normalize(event: Record<string, unknown>) {
  return new ClaudeSessionsProvider().normalizeMessage(
    { uuid: 'evt-1', session_id: SESSION_ID, ...event },
    SESSION_ID,
  );
}

test('a wrapped text delta becomes a streaming increment', () => {
  const [message] = normalize({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
  });

  assert.equal(message.kind, 'stream_delta');
  assert.equal(message.content, 'Hel');
});

test('a bare text delta is understood too', () => {
  // The unwrapped shape is what this provider originally read. A CLI that emits it
  // must not lose its streaming because a newer one wraps events instead.
  const [message] = normalize({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'lo' },
  });

  assert.equal(message.kind, 'stream_delta');
  assert.equal(message.content, 'lo');
});

test('reasoning increments are kept out of the answer stream', () => {
  const [wrapped] = normalize({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'weighing the options' },
    },
  });

  assert.equal(wrapped.kind, 'thinking_delta', 'sharing stream_delta would mix it into the answer');
  assert.equal(wrapped.content, 'weighing the options');
});

test('a bare reasoning delta is understood too', () => {
  const [message] = normalize({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: 'weighing the options' },
  });

  assert.equal(message.kind, 'thinking_delta');
});

test('a delta carrying neither the answer nor reasoning produces no row', () => {
  // Tool arguments stream as `input_json_delta`. The call itself is reported
  // separately, so a row per argument fragment would be noise with no reader.
  assert.deepEqual(
    normalize({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a"' } },
    }),
    [],
  );
});

test('a block boundary still ends the stream, wrapped or not', () => {
  assert.equal(
    normalize({ type: 'stream_event', event: { type: 'content_block_stop' } })[0].kind,
    'stream_end',
  );
  assert.equal(
    normalize({ type: 'content_block_stop' })[0].kind,
    'stream_end',
  );
});

test('an event that is neither kind of increment is left alone', () => {
  // The same early branch sees every partial event, including the block starts and
  // message boundaries that carry no text. They must fall through to the rest of the
  // normalizer rather than being consumed here.
  const start = normalize({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });

  assert.deepEqual(start, [], 'a block start with no content has nothing to show');
});
