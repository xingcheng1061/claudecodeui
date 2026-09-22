import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';

type UseResizableWidthOptions = {
  /** The outer flex row container the sidebar lives in; its left edge anchors the width. */
  containerRef: RefObject<HTMLDivElement | null>;
  min: number;
  maxRatio: number;
  initialWidth: number;
  storageKey: string;
};

/**
 * Drag-to-resize width for a left-hand sidebar, modelled on `useEditorSidebar`
 * (mousemove + rAF coalescing, body cursor/userSelect while dragging) but with
 * two differences:
 *
 * - the anchor comes from `containerRef` directly instead of walking a
 *   parentElement chain, so inserting elements around the sidebar cannot break it;
 * - the clamped result is applied even when out of range (the editor sidebar
 *   discards out-of-range moves instead, which makes the handle feel sticky).
 *
 * The width persists to `localStorage[storageKey]` on mouseup only — never
 * inside a rAF frame. When `isMobile`, the caller simply does not render the
 * resize handle, so `onResizeStart` is never invoked.
 */
export const useResizableWidth = ({
  containerRef,
  min,
  maxRatio,
  initialWidth,
  storageKey,
}: UseResizableWidthOptions) => {
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored >= min) {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return initialWidth;
  });

  // The value the last committed frame produced, so mouseup can persist exactly
  // what is on screen even when the final mousemove was coalesced away.
  const latestWidthRef = useRef(width);
  const [isResizing, setIsResizing] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  const onResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    // Mirrors the template: pointer moves land several times per frame, and
    // every commit re-renders the whole workspace, so widths coalesce to one
    // commit per animation frame.
    let pendingWidth: number | null = null;
    let frameHandle: number | null = null;

    const commitPendingWidth = () => {
      frameHandle = null;
      if (pendingWidth !== null) {
        latestWidthRef.current = pendingWidth;
        setWidth(pendingWidth);
        pendingWidth = null;
      }
    };

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const containerRect = container.getBoundingClientRect();
      // A left-hand sidebar: the width is the pointer's distance from the
      // container's left edge. Clamped, never discarded.
      const newWidth = event.clientX - containerRect.left;
      pendingWidth = Math.min(containerRect.width * maxRatio, Math.max(min, newWidth));

      if (frameHandle === null) {
        frameHandle = requestAnimationFrame(commitPendingWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
      // Land on the last position the pointer reached rather than the last
      // frame that happened to commit — then persist it.
      commitPendingWidth();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage.setItem(storageKey, String(latestWidthRef.current));
      } catch {
        // localStorage unavailable
      }
    };
  }, [containerRef, isResizing, maxRatio, min, storageKey]);

  return { width, resizeHandleRef, onResizeStart };
};
