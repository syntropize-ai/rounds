/**
 * Backwards-compatibility shim.
 *
 * The 1,555-LOC handler god-file has been split into per-domain modules
 * under `./handlers/`. This file remains as a thin re-export so external
 * imports of `ActionContext` and the `handle*` functions keep working
 * without touching every call site.
 *
 * New code should import from `./handlers/index.js` (or the specific
 * domain file) directly.
 */

export type { ActionContext } from './handlers/_context.js';
export {
  handleDashboardCreate,
  handleDashboardList,
  handleDashboardClone,
  handleDashboardAddPanels,
  handleDashboardRemovePanels,
  handleDashboardModifyPanel,
  handleDashboardSetTitle,
  handleDashboardAddVariable,
  handleInvestigationCreate,
  handleInvestigationList,
  handleInvestigationAddSection,
  handleInvestigationComplete,
  handleAlertRuleWrite,
  handleAlertRuleList,
  handleAlertRuleHistory,
  handleMetricsQuery,
  handleMetricsRangeQuery,
  handleMetricsDiscover,
  handleMetricsValidate,
  handleLogsQuery,
  handleLogsLabels,
  handleLogsLabelValues,
  handleChangesListRecent,
  handleDatasourcesList,
  handleDatasourcesSuggest,
  handleDatasourcesPin,
  handleDatasourcesUnpin,
  handleWebSearch,
  handleNavigate,
  handleFolderCreate,
  handleFolderList,
  handleOpsRunCommand,
  handleRemediationPlanCreate,
  handleRemediationPlanCreateRescue,
  handleDatasourceConfigure,
  handleOpsConnectorConfigure,
  handleSystemSettingConfigure,
} from './handlers/index.js';
