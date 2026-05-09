/**
 * Builds uPlot.Options + AlignedData from openobs's DataFrame model.
 *
 * Usage:
 *   const { options, data } = new UPlotConfigBuilder({ height: 240 })
 *     .addTimeSeriesFrames(frames)
 *     .setUnit('bytes')
 *     .build();
 *
 * Type-cast notes:
 * - uPlot's `AlignedData` is typed as a tuple with rest args: casting to
 *   `uPlot.AlignedData` at the end is necessary because we construct it as
 *   a plain `number[][]` / `(number | null)[][]` via push().
 * - `axis.values` in uPlot accepts multiple shapes; we use a DynamicValues
 *   callback and cast to Axis.Values to satisfy the union.
 */
import uPlot from 'uplot';
import type { DataFrame, Field, Threshold } from '../data/types.js';
import { getFormatter } from '../format/registry.js';
import { getSeriesColor, getSeriesColorByKey } from '../theme/series-colors.js';
import { resolveCssVar } from '../theme/resolve-css-var.js';
import { VIZ_TOKENS } from '../theme/tokens.js';

export type StackingMode = 'none' | 'normal' | 'percent';
export type NullMode = 'gap' | 'connect' | 'zero';
/**
 * `'auto'` (default): show resting point markers at every sample when each
 * point owns >25 CSS px of horizontal space (sparse data). `'never'` keeps
 * markers off; `'always'` forces them on regardless of density.
 */
export type ShowPointsMode = 'auto' | 'never' | 'always';
/**
 * Y-axis scale type. `'auto'` (default): switch to log when the non-zero value
 * range spans >3 orders of magnitude (max/min > 1000) AND the caller did not
 * pin yMin/yMax. `'linear'` always linear. `'log'` always log (uPlot
 * `distr: 3`).
 */
export type YScaleMode = 'auto' | 'linear' | 'log';

export interface UPlotConfigBuilderOptions {
  height?: number;
  showLegend?: boolean;
}

interface BuiltSeries {
  label: string;
  color: string;
  values: Array<number | null>;
  times: number[];
}

/**
 * Convert a `#rrggbb` hex color to an `rgba(...)` string at `alpha`. Returns
 * the input untouched if it doesn't parse as hex (so `var(...)` and CSS color
 * names pass through safely).
 */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m || !m[1]) return color;
  const hex = m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Stringify labels in a stable, deterministic order for color hashing. */
function stringifyLabels(labels: Record<string, string> | undefined, fallback: string): string {
  if (!labels) return fallback;
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return fallback;
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

/** Format a number for inline-legend display using the unit formatter. */
function formatValueForDisplay(
  value: number | null | undefined,
  unit: string | undefined,
  decimals: number | undefined,
): string {
  const fmt = getFormatter(unit);
  const out = fmt(value, decimals);
  return `${out.prefix ?? ''}${out.text}${out.suffix ?? ''}`;
}

export class UPlotConfigBuilder {
  private readonly height: number;
  private readonly showLegend: boolean;

  private series: BuiltSeries[] = [];
  private unit: string | undefined;
  private thresholds: Threshold[] | undefined;
  private stacking: StackingMode = 'none';
  private nullMode: NullMode = 'gap';
  private lineWidth: number = VIZ_TOKENS.series.lineWidth;
  private fillOpacity: number = 0;
  private showPointsMode: ShowPointsMode = 'auto';
  private yScaleMode: YScaleMode = 'auto';

  /** First numeric field's config.min/max, used for the y-scale. */
  private yMin: number | undefined;
  private yMax: number | undefined;

  constructor(opts?: UPlotConfigBuilderOptions) {
    this.height = opts?.height ?? 300;
    this.showLegend = opts?.showLegend ?? false;
  }

  addTimeSeriesFrames(frames: DataFrame[]): this {
    let seriesIndex = this.series.length;

    for (const frame of frames) {
      const timeField = frame.fields.find((f) => f.type === 'time') as
        | Field<number>
        | undefined;
      if (!timeField) continue;
      const times = timeField.values;

      for (const field of frame.fields) {
        if (field.type !== 'number') continue;
        const numField = field as Field<number | null>;

        // Capture axis min/max from the first numeric field only.
        if (this.yMin === undefined && numField.config.min !== undefined) {
          this.yMin = numField.config.min;
        }
        if (this.yMax === undefined && numField.config.max !== undefined) {
          this.yMax = numField.config.max;
        }

        const labelKey = stringifyLabels(field.labels, field.name);
        const color =
          numField.config.color ??
          (field.labels ? getSeriesColorByKey(labelKey) : getSeriesColor(seriesIndex));

        const label = numField.config.displayName ?? field.name;
        this.series.push({
          label,
          color,
          values: numField.values.slice(),
          times: times.slice(),
        });
        seriesIndex += 1;
      }
    }

    return this;
  }

  setUnit(unit: string | undefined): this {
    this.unit = unit;
    return this;
  }

  setThresholds(thresholds: Threshold[] | undefined): this {
    this.thresholds = thresholds;
    return this;
  }

  setStacking(mode: StackingMode): this {
    this.stacking = mode;
    return this;
  }

  setNullMode(mode: NullMode): this {
    this.nullMode = mode;
    return this;
  }

  /** Stroke width in CSS pixels for every series. */
  setLineWidth(width: number): this {
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
      this.lineWidth = width;
    }
    return this;
  }

  /**
   * Alpha (0–1) for the area fill drawn under each series. `0` (default)
   * disables the fill so single-line charts read as clean line drawings.
   */
  setFillOpacity(alpha: number): this {
    if (typeof alpha === 'number' && Number.isFinite(alpha) && alpha >= 0 && alpha <= 1) {
      this.fillOpacity = alpha;
    }
    return this;
  }

  /** Adaptive point-marker policy. See {@link ShowPointsMode}. */
  setShowPoints(mode: ShowPointsMode): this {
    this.showPointsMode = mode;
    return this;
  }

  /** Y-axis scale policy. See {@link YScaleMode}. */
  setYScale(mode: YScaleMode): this {
    this.yScaleMode = mode;
    return this;
  }

  build(): { options: uPlot.Options; data: uPlot.AlignedData } {
    // Empty: return a minimal placeholder config with an empty AlignedData.
    if (this.series.length === 0) {
      const options: uPlot.Options = {
        title: 'No data',
        width: 600,
        height: this.height,
        series: [{}],
        legend: { show: false },
      };
      return {
        options,
        data: [[]] as unknown as uPlot.AlignedData,
      };
    }

    // 1) Union + sort all time values across series.
    const timeSet = new Set<number>();
    for (const s of this.series) {
      for (const t of s.times) timeSet.add(t);
    }
    const xs = Array.from(timeSet).sort((a, b) => a - b);

    // 2) Align each series' values to the union time axis.
    const aligned: Array<Array<number | null>> = this.series.map((s) => {
      const map = new Map<number, number | null>();
      for (let i = 0; i < s.times.length; i += 1) {
        const t = s.times[i];
        if (t === undefined) continue;
        const v = s.values[i];
        map.set(t, v ?? null);
      }
      const out: Array<number | null> = new Array(xs.length);
      for (let i = 0; i < xs.length; i += 1) {
        const t = xs[i] as number;
        const v = map.get(t);
        out[i] = v === undefined ? null : v;
      }
      return out;
    });

    // 3) Optional stacking. 'percent' normalizes per-x to sum=1.
    if (this.stacking !== 'none') {
      const n = xs.length;
      if (this.stacking === 'percent') {
        const sums = new Array<number>(n).fill(0);
        for (let i = 0; i < n; i += 1) {
          for (const series of aligned) {
            const v = series[i];
            if (typeof v === 'number') sums[i]! += v;
          }
        }
        for (const series of aligned) {
          for (let i = 0; i < n; i += 1) {
            const v = series[i] ?? null;
            const s = sums[i]!;
            series[i] = typeof v === 'number' && s > 0 ? v / s : v;
          }
        }
      }
      // Normal stacking: add each series onto the running total per x.
      const running = new Array<number>(n).fill(0);
      for (const series of aligned) {
        for (let i = 0; i < n; i += 1) {
          const v = series[i] ?? null;
          if (typeof v === 'number') {
            running[i]! += v;
            series[i] = running[i]!;
          }
        }
      }
    }

    // 4) Build uPlot series configs.
    const spanGaps = this.nullMode === 'connect';
    const unit = this.unit;
    const lineWidth = this.lineWidth;
    const fillOpacity = this.fillOpacity;
    // `points.size` here doubles as the base size used by `cursor.points.size`
    // (the hover marker drawn at the crosshair). `show: false` is the default
    // for "dense" data; the adaptive rule below flips it on when data is
    // sparse enough that resting markers add legibility.
    const POINT_SIZE = 4;

    // T-202 — adaptive point markers. Estimate horizontal CSS px per data
    // point. We don't know the chart's true rendered width here (resize is
    // handled later by UPlotChart), so use a 4:3 thumb of `height * 2.4` and
    // floor at 600. If each point owns >25 px the line looks deceptively
    // continuous over a sparse sample set; flipping markers on at every
    // sample makes the cadence legible. Honors explicit `'never'` / `'always'`
    // overrides.
    const effectivePlotWidth = Math.max(600, this.height * 2.4);
    const pointDensityPx = xs.length > 0 ? effectivePlotWidth / xs.length : 0;
    const restingPointsShow =
      this.showPointsMode === 'always' ||
      (this.showPointsMode === 'auto' && pointDensityPx > 25);
    // Capture series colors here. uPlot rewrites `series[i].stroke` to
    // `fnOrSelf(stroke)` during init, so by the time the cursor.points
    // callbacks run, reading `u.series[i].stroke` returns a function — which
    // our previous `typeof === 'function'` branch silently fell back to
    // gray. Hold a parallel array of plain hex strings indexed by series
    // index (1-based, since uPlot's series[0] is the x-axis placeholder).
    const seriesColors: string[] = this.series.map((s) => s.color);
    const uplotSeries: uPlot.Series[] = [
      // x-series placeholder (required by uPlot)
      {},
      ...this.series.map((s): uPlot.Series => ({
        label: s.label,
        stroke: s.color,
        width: lineWidth,
        ...(fillOpacity > 0 ? { fill: withAlpha(s.color, fillOpacity) } : {}),
        points: {
          show: restingPointsShow,
          size: POINT_SIZE,
          stroke: s.color,
          fill: s.color,
        },
        spanGaps,
        value: (_u, v) => formatValueForDisplay(v, unit, undefined),
      })),
    ];

    // 5) Axes. x: time (ms) formatted via Intl.DateTimeFormat.
    //    y: unit-formatted splits via getFormatter(unit).
    const axisColor = resolveCssVar(VIZ_TOKENS.axis.color);
    const gridColor = resolveCssVar(VIZ_TOKENS.grid.color);
    const xAxis: uPlot.Axis = {
      stroke: axisColor,
      grid: {
        stroke: gridColor,
        width: VIZ_TOKENS.grid.lineWidth,
      },
      ticks: {
        stroke: gridColor,
        width: VIZ_TOKENS.grid.lineWidth,
      },
      font: `${VIZ_TOKENS.axis.tickFontSize}px sans-serif`,
      // Pick tick precision from the current x-scale span so that e.g. a 3-minute
      // window shows HH:MM:SS instead of duplicated HH:MM. Always 24-hour to
      // match observability conventions and avoid the ugly " PM" suffix that
      // `Intl` adds in en-US locales.
      values: ((u: uPlot, splits: number[]) => {
        const xMin = u.scales.x?.min ?? splits[0] ?? 0;
        const xMax = u.scales.x?.max ?? splits[splits.length - 1] ?? 0;
        const spanMs = xMax - xMin;
        const opts: Intl.DateTimeFormatOptions =
          spanMs < 2 * 60 * 1000
            ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
            : spanMs < 24 * 60 * 60 * 1000
              ? { hour: '2-digit', minute: '2-digit', hour12: false }
              : spanMs < 7 * 24 * 60 * 60 * 1000
                ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
                : { year: 'numeric', month: '2-digit', day: '2-digit' };
        const fmt = new Intl.DateTimeFormat(undefined, opts);
        return splits.map((ms) => fmt.format(new Date(ms)));
      }) as unknown as uPlot.Axis.Values,
    };

    const yFormatter = getFormatter(unit);
    const yAxis: uPlot.Axis = {
      stroke: axisColor,
      grid: {
        stroke: gridColor,
        width: VIZ_TOKENS.grid.lineWidth,
      },
      ticks: {
        stroke: gridColor,
        width: VIZ_TOKENS.grid.lineWidth,
      },
      font: `${VIZ_TOKENS.axis.tickFontSize}px sans-serif`,
      values: ((_u: uPlot, splits: number[]) =>
        splits.map((v) => {
          const out = yFormatter(v, undefined);
          return `${out.prefix ?? ''}${out.text}${out.suffix ?? ''}`;
        })) as unknown as uPlot.Axis.Values,
      // Dynamic gutter sizing — uPlot's default 50px is too narrow for labels
      // like "180 req/s" or "1.50 GiB" and clips the leading digit. Compute
      // width from the longest formatted tick label per render. Capped 50-140
      // so a single huge value (e.g. an outlier with many digits) can't blow
      // up the chart, and short labels stay compact.
      size: (_u, values) => {
        if (!Array.isArray(values) || values.length === 0) return 50;
        let maxLen = 0;
        for (const v of values) {
          const s = String(v ?? '');
          if (s.length > maxLen) maxLen = s.length;
        }
        // ~7 px per char at the 12px sans-serif we use, plus 16px tick + pad.
        return Math.max(50, Math.min(140, maxLen * 7 + 16));
      },
    };

    // T-203 — log scale auto-suggest. If the non-zero value range spans
    // >3 orders of magnitude (max/min > 1000), uPlot's linear y-axis crushes
    // the small band against the baseline. Switch to log (`distr: 3`) so
    // both bands remain readable. An explicit `yMin`/`yMax` from the caller
    // is treated as a strong "I want linear" signal — log scale rejects
    // negative/zero bounds and the user clearly thought about the range.
    let useLogScale = false;
    if (this.yScaleMode === 'log') {
      useLogScale = true;
    } else if (
      this.yScaleMode === 'auto' &&
      this.yMin === undefined &&
      this.yMax === undefined
    ) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      let nonzeroCount = 0;
      for (const series of aligned) {
        for (const v of series) {
          if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
          nonzeroCount += 1;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (nonzeroCount >= 2 && lo > 0 && hi / lo > 1000) {
        useLogScale = true;
      }
    }

    // 6) Scales. y honors field.config.min/max from the first numeric field.
    const scales: uPlot.Scales = {
      x: { time: true },
      y: {
        auto: this.yMin === undefined && this.yMax === undefined,
        ...(useLogScale ? { distr: 3 as const } : {}),
        ...(this.yMin !== undefined || this.yMax !== undefined
          ? {
              range: (_u, dataMin, dataMax): uPlot.Range.MinMax => [
                this.yMin ?? dataMin,
                this.yMax ?? dataMax,
              ],
            }
          : {}),
      },
    };

    // Single-series charts don't benefit from a legend.
    const legendShow = this.showLegend && this.series.length > 1;

    // Note: thresholds captured for future threshold-band rendering; not yet
    // consumed by uPlot opts (visualization layer will wire it via bands).
    void this.thresholds;

    const options: uPlot.Options = {
      width: 600, // overridden by UPlotChart via ResizeObserver
      height: this.height,
      series: uplotSeries,
      axes: [xAxis, yAxis],
      scales,
      legend: { show: legendShow },
      // Cursor marker config: at the crosshair, draw one filled circle per
      // series at twice the resting-point size, coloured the same as the
      // series line. uPlot draws one marker per visible series — when a chart
      // has many series their markers overlap on the same x, which is the
      // expected behaviour and reads as a single dense dot rather than N
      // separate hover artifacts.
      cursor: {
        // Explicit x/y = true — both crosshair axes. uPlot defaults to true,
        // but stating it here keeps the intent obvious and shields against a
        // future partial override during config merging in TimeSeriesViz.
        x: true,
        y: true,
        // Snap the crosshair to the nearest data-point x. Without snapping,
        // uPlot draws the vertical line at the raw mouse x while the
        // per-series markers sit on the snapped data x — the two visibly
        // drift apart whenever the pointer is between samples. Snapping keeps
        // the line and the dots vertically aligned at all times.
        move: (u, left, top) => {
          const xs = u.data[0];
          if (!xs || xs.length === 0) return [left, top];
          const xVal = u.posToVal(left, 'x');
          // Binary search the sorted x array for nearest entry.
          let lo = 0;
          let hi = xs.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if ((xs[mid] as number) < xVal) lo = mid + 1;
            else hi = mid;
          }
          const candidates = [lo - 1, lo].filter((i) => i >= 0 && i < xs.length);
          let best = lo;
          let bestDiff = Infinity;
          for (const i of candidates) {
            const d = Math.abs((xs[i] as number) - xVal);
            if (d < bestDiff) {
              bestDiff = d;
              best = i;
            }
          }
          const snappedLeft = u.valToPos(xs[best] as number, 'x');
          return [Number.isFinite(snappedLeft) ? snappedLeft : left, top];
        },
        points: {
          // Do NOT set `show: true` here. uPlot wraps non-functions via
          // `fnOrSelf`, which turns `true` into `() => true` — but the call
          // site expects an HTMLElement back, so a `true` return value makes
          // uPlot skip marker creation entirely. Leaving `show` undefined
          // preserves uPlot's default `cursorPointShow` factory which builds
          // the actual DOM marker.
          size: (u, sIdx) => {
            const s = u.series[sIdx];
            const sz = (s?.points as { size?: number } | undefined)?.size ?? POINT_SIZE;
            return sz * 2;
          },
          width: (_u, _sIdx, size) => size / 4,
          // Pull color from our parallel `seriesColors` array (see comment
          // where it's built) — `u.series[sIdx].stroke` is wrapped to a
          // function by uPlot during init and is no longer a string here.
          stroke: (_u, sIdx) => seriesColors[sIdx - 1] ?? '#888888',
          fill: (_u, sIdx) => seriesColors[sIdx - 1] ?? '#888888',
        },
        // Nearest-non-null index snap with a 15px scan radius. uPlot's
        // default `dataIdx` picks the strictly closest x even when that
        // sample is null — the marker then lands on a gap and visibly skips
        // between real data points as the mouse moves. Scanning outward to
        // the first non-null neighbour avoids the skip.
        dataIdx: (u, sIdx, hoveredIdx, cursorXVal) => {
          if (sIdx === 0) return hoveredIdx;
          const xs = u.data[0];
          const ys = u.data[sIdx];
          if (!xs || !ys) return hoveredIdx;
          const cursorPx = u.valToPos(cursorXVal, 'x');
          let best = hoveredIdx;
          let bestPxDist = Infinity;
          // Scan outward from hoveredIdx until we exceed 15 CSS px on either
          // side. First non-null hit wins on each side; we keep the closer.
          const SCAN_PX = 15;
          for (let dir = -1; dir <= 1; dir += 2) {
            for (let i = hoveredIdx; i >= 0 && i < xs.length; i += dir) {
              const xi = xs[i];
              if (xi === undefined) break;
              const px = u.valToPos(xi, 'x');
              if (Math.abs(px - cursorPx) > SCAN_PX) break;
              if (ys[i] != null) {
                const d = Math.abs(px - cursorPx);
                if (d < bestPxDist) {
                  bestPxDist = d;
                  best = i;
                }
                break;
              }
            }
          }
          return best;
        },
      },
    };

    const data = [xs, ...aligned] as unknown as uPlot.AlignedData;
    return { options, data };
  }
}
