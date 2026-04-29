/**
 * Per-domain action handlers, split out of the legacy 1.5k-LOC
 * `orchestrator-action-handlers.ts` (which is now a thin shim re-exporting
 * from this barrel for backwards compatibility).
 *
 * Each file hosts one observability domain (dashboard, alert, metrics, ...)
 * Shared helpers live in `_shared.ts`; the `ActionContext` type lives in
 * `_context.ts` so per-domain files can import it without forming a cycle
 * through the shim.
 */

export type { ActionContext } from './_context.js';

export {
  handleDashboardCreate,
  handleDashboardList,
  handleDashboardClone,
  handleDashboardAddPanels,
  handleDashboardRemovePanels,
  handleDashboardModifyPanel,
  handleDashboardSetTitle,
  handleDashboardAddVariable,
} from './dashboard.js';

export {
  handleInvestigationCreate,
  handleInvestigationList,
  handleInvestigationAddSection,
  handleInvestigationComplete,
} from './investigation.js';

export {
  handleAlertRuleWrite,
  handleAlertRuleList,
  handleAlertRuleHistory,
} from './alert.js';

export {
  handleMetricsQuery,
  handleMetricsRangeQuery,
  handleMetricsDiscover,
  handleMetricsValidate,
} from './metrics.js';

export {
  handleLogsQuery,
  handleLogsLabels,
  handleLogsLabelValues,
} from './logs.js';

export { handleChangesListRecent } from './changes.js';
export {
  handleDatasourcesList,
  handleDatasourcesSuggest,
  handleDatasourcesPin,
  handleDatasourcesUnpin,
} from './datasources.js';
export { handleWebSearch } from './web.js';
export { handleNavigate } from './navigation.js';
export { handleFolderCreate, handleFolderList } from './folder.js';
export { handleOpsRunCommand } from './ops.js';

export { handleRemediationPlanCreate, handleRemediationPlanCreateRescue } from './remediation-plan.js';
