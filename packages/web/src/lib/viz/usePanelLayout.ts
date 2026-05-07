/**
 * Single source of truth for responsive panel layout.
 *
 * Why this exists:
 *   Before this hook, layout magic numbers were scattered across the
 *   visualization tree — `flex: '1 1 220px'` in legend items, `maxWidth: 320`
 *   on tooltip, `containerHeight < 180` for the legend hide threshold,
 *   uPlot y-axis gutter at uPlot's default 50px. None of these talked to
 *   each other. CJK labels (~12 px/glyph vs Latin ~7) blew through every
 *   width assumption silently — a Chinese series name "请求速率" rendered
 *   as just "请" on a narrow panel because the legend item enforced a
 *   minWidth of 220 with stats `flexShrink: 0` eating the remaining space.
 *
 * What it does:
 *   ResizeObserver-driven measurement of the panel container, plus a
 *   pure decision function that maps (width, height, seriesCount,
 *   statCount, requestedMode) → a complete `PanelLayout` describing every
 *   size knob in one place. Visualizations consume the layout; nothing
 *   downstream contains hardcoded breakpoint thresholds.
 *
 * Size classes:
 *   - narrow  (< 300 px wide):    legend stacks (name on one row, stats
 *                                  beneath) so CJK / long names stay whole.
 *                                  Tooltip caps at 200 px.
 *   - medium  (300–599 px):       inline list legend, basis 140 px so a
 *                                  single CJK name + one stat fits without
 *                                  ellipsis. Tooltip caps at 240 px.
 *   - wide    (>= 600 px):        full legend (table when multi-stat ×
 *                                  multi-series, list otherwise), basis
 *                                  220 px. Tooltip caps at 320 px.
 *
 *   Below 180 px height, legend hides regardless of width — the chart
 *   itself becomes unreadable when the legend eats half the panel.
 */
import { useEffect, useState, type RefObject } from 'react';

export type PanelSizeClass = 'narrow' | 'medium' | 'wide';
export type LegendMode = 'hidden' | 'stacked' | 'list' | 'table';

const NARROW_MAX_WIDTH = 300;
const WIDE_MIN_WIDTH = 600;
const MIN_HEIGHT_FOR_LEGEND = 180;

export interface PanelLayout {
  /** Container width in CSS px. 0 until first ResizeObserver fire. */
  width: number;
  /** Container height in CSS px. 0 until first ResizeObserver fire. */
  height: number;
  sizeClass: PanelSizeClass;
  /** Tooltip max width — caps at the container minus a 16 px safety margin
   *  so a tooltip near the right edge doesn't visually overflow. */
  tooltipMaxWidth: number;
}

export interface LegendLayoutDecision {
  mode: LegendMode;
  /** Flex-basis (CSS px) for each list-mode legend item. Inline list mode
   *  only — table mode lays out columns via the table itself, stacked mode
   *  uses block layout. */
  itemBasis: number;
}

/**
 * Pure decision function — given measured layout + series shape +
 * caller's requested mode, return the legend layout to render.
 *
 * `requested` is the mode the caller would prefer; we override to
 * `stacked` on narrow containers, to `hidden` on too-short panels, and
 * to `table` when an inline list would clip with multi-stat ×
 * multi-series rows. Returning a single object means callers don't
 * branch on size class themselves — they read `layout.legend.mode`.
 */
export function decideLegendLayout(
  layout: PanelLayout,
  seriesCount: number,
  statCount: number,
  requested: 'list' | 'table' | 'hidden',
): LegendLayoutDecision {
  if (requested === 'hidden' || seriesCount === 0) {
    return { mode: 'hidden', itemBasis: 0 };
  }

  if (layout.height > 0 && layout.height < MIN_HEIGHT_FOR_LEGEND) {
    return { mode: 'hidden', itemBasis: 0 };
  }

  // Narrow containers cannot fit name + stats inline without truncating
  // CJK labels. Switch to stacked: name owns the first row, stats own
  // the second. Width-only check; even a tall narrow panel benefits.
  if (layout.sizeClass === 'narrow') {
    return { mode: 'stacked', itemBasis: 0 };
  }

  // Inline list overflows when each row carries multiple stat columns
  // across multiple series — table mode aligns the stats into proper
  // columns instead of letting them wrap raggedly.
  if (requested === 'table' || seriesCount > 6 || (seriesCount >= 2 && statCount >= 2)) {
    return { mode: 'table', itemBasis: 0 };
  }

  // Wide gets a roomier basis so series-rich panels read as a tidy
  // multi-column grid; medium goes tighter so a single CJK name + one
  // stat fits in one row.
  const itemBasis = layout.sizeClass === 'wide' ? 220 : 140;
  return { mode: 'list', itemBasis };
}

/**
 * Subscribe to a container's size via ResizeObserver and project onto a
 * `PanelLayout`. Caller passes a ref already wired to the chart
 * container — this lets the visualization keep its own ref for
 * cursor-sync / tooltip math while still using the hook to drive
 * layout decisions. The hook does NOT re-render when the inner content
 * rect changes if width/height hasn't actually changed.
 */
export function usePanelLayout(
  ref: RefObject<HTMLElement | null>,
): PanelLayout {
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setSize((prev) =>
        prev.width === r.width && prev.height === r.height
          ? prev
          : { width: r.width, height: r.height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  const sizeClass: PanelSizeClass =
    size.width === 0
      ? 'wide' // optimistic default before measurement
      : size.width < NARROW_MAX_WIDTH
        ? 'narrow'
        : size.width < WIDE_MIN_WIDTH
          ? 'medium'
          : 'wide';

  const tooltipMaxWidth =
    sizeClass === 'narrow' ? 200 : sizeClass === 'medium' ? 240 : 320;

  return { ...size, sizeClass, tooltipMaxWidth };
}
