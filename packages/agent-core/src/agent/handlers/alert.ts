import { ac, AuditAction, assertWritable, ProvisionedResourceError, type AlertCondition, type AlertOperator, type AlertSeverity, type ResourceSource } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { ActionContext } from './_context.js';
import { withWorkspaceScope } from './_shared.js';

/**
 * Backtest a freshly-generated alert rule against the default metrics
 * datasource for the session. Returns a one-line preview summary or `null`
 * when no metrics connector is registered (caller silently omits — no
 * fabrication).
 *
 * Inlined here rather than imported from api-gateway because handlers must
 * not depend on the gateway service layer (cycle). The math is intentionally
 * trivial: count time points in the lookback window where the predicate is
 * true. Mirrors `previewAlertCondition` in alert-evaluator-service.ts but
 * uses the agent's local AdapterRegistry.
 */
async function previewForAgent(
  ctx: ActionContext,
  cond: { query: string; operator: AlertOperator; threshold: number },
): Promise<{ wouldHaveFired: number; seriesCount: number; lookbackHours: number } | null> {
  const metricsSources = ctx.adapters.list({ signalType: 'metrics' });
  const chosen = metricsSources.find((d) => d.isDefault) ?? metricsSources[0];
  if (!chosen) return null;
  const adapter = ctx.adapters.metrics(chosen.id);
  if (!adapter) return null;

  const lookbackHours = 24;
  const end = new Date();
  const start = new Date(end.getTime() - lookbackHours * 3_600_000);
  let series: Awaited<ReturnType<typeof adapter.rangeQuery>>;
  try {
    series = await adapter.rangeQuery(cond.query, start, end, '60s');
  } catch {
    return null;
  }
  let wouldHaveFired = 0;
  for (const s of series) {
    for (const [, raw] of s.values) {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      const hit =
        cond.operator === '>' ? v > cond.threshold
        : cond.operator === '>=' ? v >= cond.threshold
        : cond.operator === '<' ? v < cond.threshold
        : cond.operator === '<=' ? v <= cond.threshold
        : cond.operator === '==' ? v === cond.threshold
        : cond.operator === '!=' ? v !== cond.threshold
        : false;
      if (hit) wouldHaveFired += 1;
    }
  }
  return { wouldHaveFired, seriesCount: series.length, lookbackHours };
}

/**
 * Resolve the folder-scoped RBAC evaluator for a single alert rule.
 * Falls back to the wildcard scope only when the store can't tell us where
 * the rule lives — callers still gate the call, so an unknown folder means
 * "require an org-wide grant" rather than silently widening.
 */
async function evalAlertRuleWrite(
  ctx: ActionContext,
  action: 'alert.rules:write' | 'alert.rules:delete',
  ruleId: string,
): Promise<boolean> {
  let folderUid: string | null | undefined;
  if (ctx.alertRuleStore.getFolderUid) {
    try {
      folderUid = await ctx.alertRuleStore.getFolderUid(ctx.identity.orgId, ruleId);
    } catch {
      folderUid = null;
    }
  }
  const scope = `folders:uid:${folderUid ?? '*'}`;
  return ctx.accessControl.evaluate(ctx.identity, ac.eval(action, scope));
}

const log = createLogger('handlers/alert');
const DEFAULT_ALERT_RULE_FOLDER_UID = 'alerts';
const DEFAULT_ALERT_RULE_FOLDER_TITLE = 'Alerts';

// ---------------------------------------------------------------------------
// Alert rule write — single tool with an `op` discriminator that replaces the
// previous trio (create_alert_rule, modify_alert_rule, delete_alert_rule).
//
// The model now picks the verb by argument instead of guessing among three
// sibling tool names; per-op required-arg validation lives in handleAlertRuleWrite.
// ---------------------------------------------------------------------------

type AlertRuleWriteOp = 'create' | 'update' | 'delete';

const ALERT_RULE_WRITE_OPS: ReadonlySet<AlertRuleWriteOp> = new Set(['create', 'update', 'delete']);

interface AlertRuleCreateSpec {
  name: string;
  description: string;
  condition: AlertCondition;
  evaluationIntervalSec: number;
  severity: AlertSeverity;
  labels?: Record<string, string>;
  autoInvestigate?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseCreateSpec(raw: unknown): AlertRuleCreateSpec | string {
  if (!isPlainObject(raw)) return 'alert_rule_write with op="create" requires "spec".';
  const condition = raw.condition;
  if (!isPlainObject(condition)) return 'alert_rule_write create spec requires condition.';

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const query = typeof condition.query === 'string' ? condition.query.trim() : '';
  const operator = condition.operator as AlertCondition['operator'];
  const threshold = condition.threshold;
  const forDurationSec = condition.forDurationSec;
  const evaluationIntervalSec = raw.evaluationIntervalSec;
  const severity = raw.severity as AlertSeverity;

  if (!name) return 'alert_rule_write create spec requires name.';
  if (!description) return 'alert_rule_write create spec requires description.';
  if (!query) return 'alert_rule_write create spec requires condition.query.';
  if (!['>', '<', '>=', '<=', '=='].includes(operator)) return 'alert_rule_write create spec requires condition.operator.';
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return 'alert_rule_write create spec requires numeric condition.threshold.';
  if (typeof forDurationSec !== 'number' || !Number.isFinite(forDurationSec)) return 'alert_rule_write create spec requires numeric condition.forDurationSec.';
  if (typeof evaluationIntervalSec !== 'number' || !Number.isFinite(evaluationIntervalSec) || evaluationIntervalSec <= 0) return 'alert_rule_write create spec requires positive evaluationIntervalSec.';
  if (!['critical', 'high', 'medium', 'low'].includes(severity)) return 'alert_rule_write create spec requires severity.';
  if (raw.labels !== undefined && !isPlainObject(raw.labels)) return 'alert_rule_write create spec labels must be an object.';
  if (isPlainObject(raw.labels) && Object.values(raw.labels).some((v) => typeof v !== 'string')) {
    return 'alert_rule_write create spec labels must be string values.';
  }
  if (raw.autoInvestigate !== undefined && typeof raw.autoInvestigate !== 'boolean') {
    return 'alert_rule_write create spec autoInvestigate must be boolean.';
  }

  return {
    name,
    description,
    condition: { query, operator, threshold, forDurationSec },
    evaluationIntervalSec,
    severity,
    labels: isPlainObject(raw.labels) ? raw.labels as Record<string, string> : {},
    autoInvestigate: raw.autoInvestigate === true,
  };
}

async function createAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '');
  const folderUid = await resolveAlertRuleFolderUid(ctx, args);
  const spec = parseCreateSpec(args.spec);
  if (typeof spec === 'string') return `Error: ${spec}`;
  const generated = spec;

  // Upsert: if a rule with the same name exists IN THE CALLER'S WORKSPACE,
  // update it. The lookup MUST be workspace-scoped — a global findAll() +
  // name match can return a row from another workspace, and the subsequent
  // update would silently overwrite that other workspace's rule (data leak).
  // We do NOT swallow store errors here — silently falling through to
  // `create` when findByWorkspace/update fails produces duplicate rules
  // with identical names, which is worse UX than a visible error.
  let rule: Record<string, unknown> | undefined;
  let isUpdate = false;
  if (ctx.alertRuleStore.update) {
    let scopedList: Array<{ id: string; name: string }> | undefined;
    try {
      if (ctx.alertRuleStore.findByWorkspace) {
        scopedList = (await ctx.alertRuleStore.findByWorkspace(
          ctx.identity.orgId,
        )) as Array<{ id: string; name: string }>;
      } else if (ctx.alertRuleStore.findAll) {
        // Fallback for stores without findByWorkspace — narrow client-side
        // by workspaceId so we don't cross-tenant.
        const existing = await ctx.alertRuleStore.findAll();
        const all = (Array.isArray(existing)
          ? existing
          : (existing as { list: unknown[] }).list ?? []) as Array<{
            id: string;
            name: string;
            workspaceId?: string;
          }>;
        scopedList = all.filter((r) => r.workspaceId === ctx.identity.orgId);
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), tool: 'alert_rule_write', op: 'create' },
        'alertRuleStore lookup failed during upsert — re-throwing to avoid silent duplicate creation',
      );
      throw err;
    }
    const match = scopedList?.find((r) => r.name === generated.name);
    if (match) {
      // Writable gate — refuse to upsert into a provisioned (GitOps/file) rule.
      if (ctx.alertRuleStore.findById) {
        const found = await ctx.alertRuleStore.findById(match.id) as { source?: ResourceSource } | undefined;
        try {
          assertWritable({
            kind: 'alert_rule',
            id: match.id,
            source: (found?.source ?? 'manual'),
          });
        } catch (err) {
          if (err instanceof ProvisionedResourceError) {
            return `Error: ${err.message}`;
          }
          throw err;
        }
      }
      rule = await ctx.alertRuleStore.update(match.id, {
        description: generated.description,
        condition: generated.condition,
        evaluationIntervalSec: generated.evaluationIntervalSec,
        severity: generated.severity,
      }) as Record<string, unknown> | undefined;
      isUpdate = true;
    }
  }

  if (!rule) {
    // Same reason as dashboard_create / investigation_create: the list
    // route filters by workspaceId, so an un-scoped row is invisible
    // even though it's in the store.
    rule = await ctx.alertRuleStore.create(
      withWorkspaceScope(ctx.identity, {
        name: generated.name,
        description: generated.description,
        originalPrompt: generated.description,
        condition: generated.condition,
        evaluationIntervalSec: generated.evaluationIntervalSec,
        severity: generated.severity,
        labels: { ...generated.labels, ...(dashboardId ? { dashboardId } : {}) },
        folderUid,
        createdBy: 'llm',
        // Agent-tool created — see writable-gate.ts for source taxonomy.
        source: 'ai_generated' as ResourceSource,
      }),
    ) as Record<string, unknown>;
  }

  const rc = rule.condition as Record<string, unknown>;
  const verb = isUpdate ? 'Updated' : 'Created';
  void ctx.auditWriter?.({
    action: isUpdate ? AuditAction.AlertRuleUpdate : AuditAction.AlertRuleCreate,
    actorType: 'user',
    actorId: ctx.identity.userId,
    orgId: ctx.identity.orgId,
    targetType: 'alert_rule',
    targetId: String(rule.id ?? ''),
    targetName: String(rule.name ?? generated.name),
    outcome: 'success',
    metadata: { severity: rule.severity, folderUid, via: 'agent_tool' },
  });
  ctx.pushConversationAction({
    type: 'create_alert_rule',
    ruleId: String(rule.id ?? ''),
    name: String(rule.name ?? generated.name),
    severity: String(rule.severity ?? generated.severity),
    query: String(rc.query ?? ''),
    operator: String(rc.operator ?? ''),
    threshold: Number(rc.threshold ?? 0),
    forDurationSec: Number(rc.forDurationSec ?? 0),
    evaluationIntervalSec: Number(rule.evaluationIntervalSec ?? generated.evaluationIntervalSec),
  });
  // Preview / backtest summary — best-effort. Omitted entirely when no
  // metrics connector is wired so we don't fabricate numbers.
  let previewText = '';
  try {
    const preview = await previewForAgent(ctx, {
      query: String(rc.query ?? ''),
      operator: String(rc.operator ?? '>') as AlertOperator,
      threshold: Number(rc.threshold ?? 0),
    });
    if (preview) {
      previewText = ` Preview: would have fired ${preview.wouldHaveFired} time(s) across ${preview.seriesCount} series in the last ${preview.lookbackHours}h.`;
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alert preview failed; omitting from tool result',
    );
  }
  return `${verb} alert rule "${rule.name}" (id: ${rule.id ?? 'unknown'}, ${rule.severity}, evaluating every ${rule.evaluationIntervalSec}s). Rule: ${rc.query} ${rc.operator} ${rc.threshold} for ${rc.forDurationSec}s.${previewText}`;
}

async function resolveAlertRuleFolderUid(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const requested = typeof args.folderUid === 'string' ? args.folderUid.trim() : '';
  if (requested) return requested;

  if (!ctx.folderRepository) {
    throw new Error('Folder backend is required to create alert rules without an explicit folder.');
  }

  const existing = await ctx.folderRepository.findByUid(
    ctx.identity.orgId,
    DEFAULT_ALERT_RULE_FOLDER_UID,
  );
  if (existing) return existing.uid;

  const created = await ctx.folderRepository.create({
    uid: DEFAULT_ALERT_RULE_FOLDER_UID,
    orgId: ctx.identity.orgId,
    title: DEFAULT_ALERT_RULE_FOLDER_TITLE,
    description: 'Default folder for alert rules created without an explicit folder.',
    parentUid: null,
    createdBy: ctx.identity.userId,
    updatedBy: ctx.identity.userId,
    source: 'ai_generated',
  });
  return created.uid;
}

async function updateAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = String(args.ruleId ?? '');
  const patch = (args.patch ?? args) as Record<string, unknown>;
  if (!ctx.alertRuleStore.update) return 'Error: alert rule store does not support updates.';
  if (!ctx.alertRuleStore.findById) return 'Error: alert rule store does not support findById.';

  const existingRule = await ctx.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined;
  if (!existingRule) return `Error: alert rule ${ruleId} not found.`;

  // Writable gate — refuse to mutate provisioned (GitOps/file) rules.
  try {
    assertWritable({
      kind: 'alert_rule',
      id: ruleId,
      source: ((existingRule.source as ResourceSource | undefined) ?? 'manual'),
    });
  } catch (err) {
    if (err instanceof ProvisionedResourceError) {
      return `Error: ${err.message}`;
    }
    throw err;
  }

  // RBAC: derive the rule's folder UID and require alert.rules:write on it.
  // The pre-dispatch tool gate already runs, but defense-in-depth here keeps
  // the handler safe if the gate is ever bypassed (e.g. internal callers).
  const allowed = await evalAlertRuleWrite(ctx, 'alert.rules:write', ruleId);
  if (!allowed) {
    return `Error: not authorized to modify alert rule ${ruleId}.`;
  }

  const updatePatch: Record<string, unknown> = {};
  if (patch.severity) updatePatch.severity = patch.severity;
  if (patch.evaluationIntervalSec) updatePatch.evaluationIntervalSec = patch.evaluationIntervalSec;
  if (patch.name) updatePatch.name = patch.name;

  const existingCondition = (existingRule.condition ?? {}) as Record<string, unknown>;
  const hasConditionChanges = patch.threshold !== undefined || patch.operator || patch.forDurationSec !== undefined || patch.query;
  if (hasConditionChanges) {
    updatePatch.condition = {
      ...existingCondition,
      ...(patch.threshold !== undefined ? { threshold: patch.threshold } : {}),
      ...(patch.operator ? { operator: patch.operator } : {}),
      ...(patch.forDurationSec !== undefined ? { forDurationSec: patch.forDurationSec } : {}),
      ...(patch.query ? { query: patch.query } : {}),
    };
  }

  const updatedRule = await ctx.alertRuleStore.update(ruleId, updatePatch) as Record<string, unknown> | undefined;

  void ctx.auditWriter?.({
    action: AuditAction.AlertRuleUpdate,
    actorType: 'user',
    actorId: ctx.identity.userId,
    orgId: ctx.identity.orgId,
    targetType: 'alert_rule',
    targetId: ruleId,
    targetName: String(updatedRule?.name ?? existingRule.name ?? ''),
    outcome: 'success',
    metadata: { patch: updatePatch, via: 'agent_tool' },
  });

  ctx.pushConversationAction({
    type: 'modify_alert_rule',
    ruleId,
    patch: {
      ...(patch.threshold !== undefined ? { threshold: Number(patch.threshold) } : {}),
      ...(typeof patch.operator === 'string' ? { operator: patch.operator } : {}),
      ...(typeof patch.severity === 'string' ? { severity: patch.severity } : {}),
      ...(patch.forDurationSec !== undefined ? { forDurationSec: Number(patch.forDurationSec) } : {}),
      ...(patch.evaluationIntervalSec !== undefined ? { evaluationIntervalSec: Number(patch.evaluationIntervalSec) } : {}),
      ...(typeof patch.query === 'string' ? { query: patch.query } : {}),
      ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
    },
  });

  const updatedRuleName = String(updatedRule?.name ?? existingRule.name ?? 'the alert rule');
  const updatedCondition = ((updatedRule?.condition ?? updatePatch.condition ?? existingCondition) as Record<string, unknown>);
  const thresholdText = updatedCondition.threshold !== undefined ? ` to ${updatedCondition.threshold}` : '';
  const operatorText = typeof updatedCondition.operator === 'string' ? ` (${updatedCondition.operator})` : '';
  return `Updated "${updatedRuleName}"${thresholdText}${operatorText}.`;
}

async function deleteAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = String(args.ruleId ?? '');

  if (!ctx.alertRuleStore.delete) {
    return 'Error: alert rule store does not support delete.';
  }

  const existingRule = ctx.alertRuleStore.findById
    ? await ctx.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined
    : undefined;

  // Writable gate — refuse to delete provisioned (GitOps/file) rules.
  if (existingRule) {
    try {
      assertWritable({
        kind: 'alert_rule',
        id: ruleId,
        source: ((existingRule.source as ResourceSource | undefined) ?? 'manual'),
      });
    } catch (err) {
      if (err instanceof ProvisionedResourceError) {
        return `Error: ${err.message}`;
      }
      throw err;
    }
  }

  // RBAC: same guard as update — defense-in-depth in case the pre-dispatch
  // tool gate is bypassed by an internal caller.
  const allowed = await evalAlertRuleWrite(ctx, 'alert.rules:delete', ruleId);
  if (!allowed) {
    return `Error: not authorized to delete alert rule ${ruleId}.`;
  }

  await ctx.alertRuleStore.delete(ruleId);

  void ctx.auditWriter?.({
    action: AuditAction.AlertRuleDelete,
    actorType: 'user',
    actorId: ctx.identity.userId,
    orgId: ctx.identity.orgId,
    targetType: 'alert_rule',
    targetId: ruleId,
    targetName: String(existingRule?.name ?? ''),
    outcome: 'success',
    metadata: { via: 'agent_tool' },
  });

  ctx.pushConversationAction({ type: 'delete_alert_rule', ruleId });

  const deletedRuleName = String(existingRule?.name ?? 'the alert rule');
  return `Deleted "${deletedRuleName}".`;
}

export async function handleAlertRuleWrite(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const opRaw = typeof args.op === 'string' ? args.op : '';
  if (!opRaw) {
    return 'Error: alert_rule_write requires "op" (one of: create, update, delete).';
  }
  if (!ALERT_RULE_WRITE_OPS.has(opRaw as AlertRuleWriteOp)) {
    return `Error: alert_rule_write received unknown op "${opRaw}". Expected one of: create, update, delete.`;
  }
  const op = opRaw as AlertRuleWriteOp;

  // Per-op required-arg validation. Error messages name the missing arg so
  // the LLM can retry without guessing.
  if (op === 'create') {
    const parsed = parseCreateSpec(args.spec);
    if (typeof parsed === 'string') {
      return `Error: ${parsed}`;
    }
  }
  if (op === 'update' || op === 'delete') {
    if (!args.ruleId || typeof args.ruleId !== 'string') {
      return `Error: alert_rule_write with op="${op}" requires "ruleId".`;
    }
  }

  const displayText = op === 'create'
    ? `Creating alert rule: ${String((args.spec as { name?: unknown } | undefined)?.name ?? '').slice(0, 60)}`
    : op === 'update'
      ? `Updating alert rule ${String(args.ruleId ?? '')}...`
      : `Deleting alert rule ${String(args.ruleId ?? '')}...`;

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'alert_rule_write',
    args: { op, ...(args.ruleId ? { ruleId: args.ruleId } : {}) },
    displayText,
  });

  try {
    let observation: string;
    switch (op) {
      case 'create':
        observation = await createAlertRule(ctx, args);
        break;
      case 'update':
        observation = await updateAlertRule(ctx, args);
        break;
      case 'delete':
        observation = await deleteAlertRule(ctx, args);
        break;
      default: {
        const _exhaustive: never = op;
        throw new Error(`alert_rule_write: unhandled op ${String(_exhaustive)}`);
      }
    }
    const success = !observation.startsWith('Error:');
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule_write', summary: observation, success });
    ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'alert_rule_write', summary: observation }));
    return observation;
  } catch (err) {
    const msg = `alert_rule_write (${op}) failed: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule_write', summary: msg, success: false });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Alert rule list
// ---------------------------------------------------------------------------

function matchesFilter(text: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!text) return false;
  return text.toLowerCase().includes(filter.toLowerCase());
}

// TODO: migrate to withToolEventBoundary
export async function handleAlertRuleList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.alertRuleStore.findAll) {
    return 'Error: alert rule store does not support listing.';
  }
  const filter = typeof args.filter === 'string' ? args.filter : undefined;
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'alert_rule_list',
    args: filter ? { filter } : {},
    displayText: filter ? `Searching alert rules matching "${filter}"` : 'Listing alert rules',
  });

  try {
    const result = await ctx.alertRuleStore.findAll();
    const rawList = (Array.isArray(result) ? result : (result as { list?: unknown[] }).list ?? []) as Array<{
      id: string
      name: string
      severity: string
      condition: { query: string; operator: string; threshold: number }
    }>;
    const list = await ctx.accessControl.filterByPermission(
      ctx.identity,
      rawList,
      (r) => ac.eval(
        'alert.rules:read',
        `alert.rules:uid:${r.id ?? ''}`,
      ),
    );
    const filtered = list.filter((r) => matchesFilter(r.name, filter));
    if (filtered.length === 0) {
      const msg = filter
        ? `No alert rules match "${filter}" (${list.length} total).`
        : 'No alert rules found.';
      ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule_list', summary: msg, success: true });
      return msg;
    }
    const lines = filtered.map((r) => {
      const c = r.condition ?? ({} as Record<string, unknown>);
      return `- [${r.id}] "${r.name}" (${r.severity}) — ${c.query ?? ''} ${c.operator ?? ''} ${c.threshold ?? ''}`;
    });
    const summary = `${filtered.length} alert rule(s)${filter ? ` matching "${filter}"` : ''}:\n${lines.join('\n')}`;
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'alert_rule_list',
      summary: `${filtered.length} alert rules found`,
      success: true,
    });
    return summary;
  } catch (err) {
    const msg = `Failed to list alert rules: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule_list', summary: msg, success: false });
    return msg;
  }
}

// ---------------------------------------------------------------------------
// Alert rule history — recent firing/resolution events for annotation overlays
// ---------------------------------------------------------------------------

interface RawHistoryEntry {
  id?: string;
  ruleId?: string;
  ruleName?: string;
  fromState?: string;
  toState?: string;
  value?: number;
  threshold?: number;
  timestamp?: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ff6e84',
  high: '#f07934',
  medium: '#e2b007',
  low: '#3e7bfa',
};

// TODO: migrate to withToolEventBoundary
export async function handleAlertRuleHistory(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = typeof args.ruleId === 'string' ? args.ruleId : undefined;
  const sinceMinutes = typeof args.sinceMinutes === 'number' ? args.sinceMinutes : 60;
  const limit = typeof args.limit === 'number' ? args.limit : 50;

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'alert_rule_history',
    args: { ruleId, sinceMinutes, limit },
    displayText: ruleId
      ? `Fetching history for rule ${ruleId} (last ${sinceMinutes} min)`
      : `Fetching alert history (last ${sinceMinutes} min)`,
  });

  // Both methods are optional; bail with a helpful message instead of throwing
  // so the agent can decide whether to retry or skip annotations.
  const fetcher = ruleId
    ? ctx.alertRuleStore.getHistory?.bind(ctx.alertRuleStore, ruleId, limit)
    : ctx.alertRuleStore.getAllHistory?.bind(ctx.alertRuleStore, limit);
  if (!fetcher) {
    const msg = 'Alert history is not available from this store; skip annotations.';
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule_history', summary: msg, success: false });
    return msg;
  }

  // Severity lookup is best-effort: if the store lists rules, we can color
  // each annotation by the rule's severity. Failure here is not fatal.
  const severityByRule = new Map<string, string>();
  try {
    if (ctx.alertRuleStore.findAll) {
      const rules = await ctx.alertRuleStore.findAll();
      for (const r of Array.isArray(rules) ? rules : []) {
        if (r && typeof r === 'object') severityByRule.set(r.id, r.severity);
      }
    }
  } catch {
    // ignore — we'll fall back to generic colors
  }

  try {
    const raw = (await fetcher()) as RawHistoryEntry[];
    const cutoffMs = Date.now() - sinceMinutes * 60_000;
    // Map only state TRANSITIONS to firing — entering 'firing' is the moment
    // worth marking. Resolutions are useful too but noisier; include them as
    // a separate label so the agent can filter if it wants a cleaner overlay.
    const annotations = raw
      .map((e) => {
        const tMs = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
        if (!Number.isFinite(tMs) || tMs < cutoffMs) return null;
        const ruleName = e.ruleName ?? 'unknown';
        const ruleSeverity = e.ruleId ? severityByRule.get(e.ruleId) : undefined;
        const color = ruleSeverity ? SEVERITY_COLOR[ruleSeverity] : SEVERITY_COLOR.medium;
        let label: string;
        if (e.toState === 'firing') {
          label = `${ruleName} fired`;
          if (typeof e.value === 'number' && typeof e.threshold === 'number') {
            label += ` (value=${e.value}, threshold=${e.threshold})`;
          }
        } else if (e.toState === 'resolved') {
          label = `${ruleName} resolved`;
        } else {
          label = `${ruleName}: ${e.fromState ?? '?'} → ${e.toState ?? '?'}`;
        }
        return { time: tMs, label, color };
      })
      .filter((a): a is { time: number; label: string; color: string } => a !== null)
      .sort((a, b) => a.time - b.time);

    const summary = annotations.length === 0
      ? `No alert state changes in the last ${sinceMinutes} minute(s).`
      : `Found ${annotations.length} alert event(s). Pass the JSON below as \`panel.annotations\` on time-axis panels:\n\`\`\`json\n${JSON.stringify(annotations, null, 2)}\n\`\`\``;

    ctx.sendEvent({
      type: 'tool_result',
      tool: 'alert_rule_history',
      summary: `${annotations.length} alert events`,
      success: true,
    });
    return summary;
  } catch (err) {
    const msg = `Failed to load alert history: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule_history', summary: msg, success: false });
    return msg;
  }
}
