/**
 * Core data model for openobs's chart stack.
 *
 * A `DataFrame` is a columnar table: a set of named `Field`s, each a parallel
 * array of values of a single logical type. Time-series data is represented
 * as two fields (a time column + one or more number columns); tabular data
 * is represented as a mix of string/number columns.
 *
 * This is an original implementation. The conceptual shape (frames + fields
 * with `config` for display-layer hints) is an industry pattern, but no code
 * is copied from any other project.
 */

/** Logical kind of values stored in a `Field`. */
export type FieldType = 'time' | 'number' | 'string' | 'boolean' | 'other';

/**
 * A threshold step. Thresholds are stored in ascending `value` order; when
 * resolving a color for some numeric sample, pick the last threshold whose
 * `value` is <= the sample (equivalently: the first threshold with
 * `value <= current` when iterating from the top down).
 */
export interface Threshold {
  value: number;
  color: string;
}

/**
 * Display-layer configuration for a field. These are hints for the
 * visualization; none of them affect the underlying `values` array.
 */
export interface FieldConfig {
  /** Unit identifier (e.g. `'bytes'`, `'percent'`, `'s'`). */
  unit?: string;
  /** Human-friendly override for the field name in legends / tooltips. */
  displayName?: string;
  /** Decimal places to render. `undefined` means "auto". */
  decimals?: number;
  /** Soft min for axis scaling. */
  min?: number;
  /** Soft max for axis scaling. */
  max?: number;
  /** Base color for single-series rendering. */
  color?: string;
  /** Threshold steps, ascending by `value`. */
  thresholds?: Threshold[];
  /** Text to render when a value is null / NaN. */
  noValue?: string;
}

/**
 * One column in a `DataFrame`. `T` is the JavaScript type of `values`
 * entries — `number` for `type: 'time' | 'number'`, `string` for
 * `type: 'string'`, and so on. Widen `T` to `number | null` etc. to
 * represent gaps (e.g. a missing sample in a Prometheus range response).
 */
export interface Field<T = unknown> {
  name: string;
  type: FieldType;
  values: T[];
  config: FieldConfig;
  /** Prometheus-style labels for the source series, when applicable. */
  labels?: Record<string, string>;
}

/**
 * Optional frame-level metadata. Attached to a `DataFrame` as `meta?` when
 * useful for downstream consumers (e.g. a stat panel wanting the executed
 * query string for a tooltip).
 */
export interface DataFrameMeta {
  unit?: string;
  executedQuery?: string;
}

/**
 * A columnar table. `length` is the longest field's value count; shorter
 * fields are treated as having `null` in the missing slots by consumers.
 */
export interface DataFrame {
  name?: string;
  refId?: string;
  fields: Field[];
  length: number;
  meta?: DataFrameMeta;
}
