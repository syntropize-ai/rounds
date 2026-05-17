/**
 * Built-in rule registry. Add a new rule here once it's been written and
 * tested in this folder; the engine has no auto-discovery.
 */

import type { LintRule } from '../types.js';
import { panelReturnsData } from './panel-returns-data.js';
import { queryUsesKnownLabels } from './query-uses-known-labels.js';
import { unitMatchesMetric } from './unit-matches-metric.js';
import { noDuplicateQueries } from './no-duplicate-queries.js';
import { highCardinalityGrouping } from './high-cardinality-grouping.js';
import { histogramQuantileForm } from './histogram-quantile-form.js';
import { vizMatchesData } from './viz-matches-data.js';
import { missingGroupingDim } from './missing-grouping-dim.js';
import { dashboardHasQuestions } from './dashboard-has-questions.js';
import { timeRangeSane } from './time-range-sane.js';

export {
  panelReturnsData,
  queryUsesKnownLabels,
  unitMatchesMetric,
  noDuplicateQueries,
  highCardinalityGrouping,
  histogramQuantileForm,
  vizMatchesData,
  missingGroupingDim,
  dashboardHasQuestions,
  timeRangeSane,
};

export const BUILTIN_RULES: LintRule[] = [
  panelReturnsData,
  queryUsesKnownLabels,
  unitMatchesMetric,
  noDuplicateQueries,
  highCardinalityGrouping,
  histogramQuantileForm,
  vizMatchesData,
  missingGroupingDim,
  dashboardHasQuestions,
  timeRangeSane,
];
