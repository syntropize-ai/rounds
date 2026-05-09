/**
 * Barrel entry for the openobs chart data layer.
 *
 * Consumers should import from `@/lib/data` (or the relative path
 * equivalent) rather than reaching into individual files, so the internal
 * shape can evolve without touching call sites.
 */
export type {
  DataFrame,
  DataFrameMeta,
  Field,
  FieldConfig,
  FieldType,
  Threshold,
} from './types.js';

export {
  createTimeSeriesFrame,
  getFieldDisplayName,
  getNumberFields,
  getTimeField,
} from './frame.js';
export type { CreateTimeSeriesFrameOptions } from './frame.js';

export { instantResponseToFrame, rangeResponseToFrames } from './transform.js';
export type { TransformOptions } from './transform.js';
