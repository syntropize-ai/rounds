/**
 * Public surface of the dashboard lint engine.
 *
 * Consumers (today: the `dashboard_lint` agent tool) import LintEngine,
 * register `BUILTIN_RULES`, and call `run(spec, ctx)` after the agent
 * drafts panels. The shape is ESLint-inspired: a registry of named rules
 * each producing an issue list.
 */

export type {
  DashboardSpec,
  LintContext,
  LintIssue,
  LintRule,
  LintRunOptions,
  LintSeverity,
} from './types.js';
export { LintEngine } from './engine.js';
export { BUILTIN_RULES } from './rules/index.js';
