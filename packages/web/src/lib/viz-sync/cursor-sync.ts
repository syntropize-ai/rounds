/**
 * Cross-panel cursor sync.
 *
 * uPlot has its own `cursor.sync.key` mechanism that ties multiple uPlot
 * instances together — but heatmap (and any future canvas-based viz) lives
 * outside that hub. This module is a tiny `window`-scoped event bus that
 * canvas-rendered panels publish to, and that uPlot-based panels subscribe to
 * so they can update their crosshair when a heatmap cell is hovered.
 *
 * Why `window` events: same dashboard = same window, no need for React
 * context plumbing or a singleton import. Subscribers self-filter by
 * `sourceId` to avoid feedback loops when a panel both publishes and
 * subscribes (which we currently don't, but the guard costs nothing).
 */

const EVENT_NAME = 'openobs:panel-cursor';

export interface CursorEventDetail {
  /** Timestamp in ms since epoch, or `null` to clear the crosshair. */
  ts: number | null;
  /**
   * Pointer Y position as a fraction of the publisher's plot area height
   * (0 = top of plot, 1 = bottom). Subscribers multiply by their own plot
   * height to place a horizontal crosshair at the same relative vertical
   * position. Omit when the publisher has no meaningful Y (e.g. cleared
   * cursor) — subscribers then fall back to mid-plot.
   */
  topPct?: number;
  /** Stable id of the publisher (used by subscribers to skip self-echoes). */
  sourceId: string;
  /** Dashboard scope. Only subscribers with the same key react. */
  syncKey: string;
}

export function publishCursor(detail: CursorEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CursorEventDetail>(EVENT_NAME, { detail }));
}

export function subscribeCursor(
  syncKey: string,
  sourceId: string,
  handler: (detail: CursorEventDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event): void => {
    const detail = (ev as CustomEvent<CursorEventDetail>).detail;
    if (!detail) return;
    if (detail.syncKey !== syncKey) return;
    if (detail.sourceId === sourceId) return;
    handler(detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
