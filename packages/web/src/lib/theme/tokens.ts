/**
 * Visualization-specific design tokens.
 *
 * These complement — and do not replace — the global `--color-*` CSS
 * variables declared in `src/index.css`. Values reference those variables
 * via `var(...)` where the visualization chrome should track the surface
 * palette (tooltip backgrounds, axis labels, etc.).
 */
export const VIZ_TOKENS = {
  axis: {
    labelFontSize: 11,
    tickFontSize: 10,
    color: 'var(--color-on-surface-variant)',
  },
  grid: {
    // `--color-outline-variant` is tuned per-theme to be faintly visible against
    // the panel background (a translucent bluish-gray on dark, a pale neutral
    // on light). `resolveCssVar` is used at read time so canvas/uPlot code
    // gets a real color string even though this value is a CSS var reference.
    color: 'var(--color-outline-variant)',
    lineWidth: 1,
    dashed: false,
  },
  tooltip: {
    background: 'var(--color-surface-high)',
    border: '1px solid var(--color-outline-variant)',
    borderRadius: 6,
    fontSize: 12,
  },
  series: {
    lineWidth: 1,
    pointSize: 0,
    hoverPointSize: 4,
  },
  null: {
    display: 'gap' as 'gap' | 'connect' | 'zero',
  },
} as const;

export type VizTokens = typeof VIZ_TOKENS;
