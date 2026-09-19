import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

/**
 * Reasoning manages its own disclosure: it opens while the reasoning is being produced and
 * shuts a second after it settles. That is why the transcript passes `isStreaming` and
 * leaves `defaultOpen` unset on screen — an explicit `false` is read as the reader having
 * shut it themselves, which suppresses the automatic half entirely.
 *
 * It is also why the block stays readable through a stream. The live reasoning row is
 * rewritten on every stream tick, so it is remounted on every tick, and each remount
 * re-applies `defaultOpen ?? isStreaming` — which is to say, each remount opens it again.
 * Whatever else that costs, it costs nothing the reader can see.
 *
 * The one thing the automatic half must never do is overrule the reader, which is the
 * third test here and the only one that is not about the stream.
 *
 * The disclosure is drawn by collapsing a grid row, so the reasoning text is in the DOM
 * whether it is open or not. The assertions are therefore about the disclosure's own state,
 * not about the text being present.
 */

const REASONING = 'Weighing the two options before answering.';

const thinkingMessage = (isStreaming: boolean): ChatMessage => ({
  type: 'assistant',
  content: REASONING,
  timestamp: '2026-09-19T10:00:00.000Z',
  isThinking: true,
  isStreaming,
});

const createDiff = (): DiffLine[] => [];

/** The disclosure's own view of itself. */
const isExpanded = (container: HTMLElement): string | null =>
  container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? null;

const renderThinking = (isStreaming: boolean) => (
  <UiPreferencesProvider>
    <MessageComponent
      message={thinkingMessage(isStreaming)}
      prevMessage={null}
      createDiff={createDiff}
      provider="claude"
      showThinking
    />
  </UiPreferencesProvider>
);

test('reasoning opens itself while it streams', () => {
  const { container } = render(renderThinking(true));

  assert.equal(isExpanded(container), 'true', 'the reader should not have to chase it open');
});

test('and shuts itself once the reasoning has settled', () => {
  vi.useFakeTimers();
  try {
    const { container, rerender } = render(renderThinking(true));
    assert.equal(isExpanded(container), 'true');

    rerender(renderThinking(false));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    assert.equal(isExpanded(container), 'false', 'a settled block stops taking up the room');
  } finally {
    vi.useRealTimers();
  }
});

test('a block the reader closes while it streams stays closed', () => {
  // Without this the block is impossible to close until the reasoning stops: the automatic
  // half re-opens any shut block it is still eligible for, so the reader's click would be
  // undone on the very next render.
  const { container } = render(renderThinking(true));

  fireEvent.click(container.querySelector('button[aria-expanded]') as HTMLButtonElement);

  assert.equal(isExpanded(container), 'false', 'the automatic half must yield to the reader');
});

test('the row says what it is doing either way', () => {
  assert.match(render(renderThinking(true)).container.textContent ?? '', /Thinking/);
  assert.match(render(renderThinking(false)).container.textContent ?? '', /Thought for/);
});
