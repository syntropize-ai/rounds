import { ac } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { ActionContext } from './_context.js';
import { withWorkspaceScope } from './_shared.js';

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

// ---------------------------------------------------------------------------
// Alert rules (still uses AlertRuleAgent for PromQL generation)
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleCreateAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const prompt = String(args.prompt ?? args.goal ?? '');
  const dashboardId = String(args.dashboardId ?? '');
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'create_alert_rule',
    args: { prompt },
    displayText: `Creating alert rule: ${prompt.slice(0, 60)}`,
  });

  const currentDash = dashboardId ? await ctx.store.findById(dashboardId) : undefined;
  const existingQueries = (currentDash?.panels ?? [])
    .flatMap((p) => [
      ...(p.queries ?? []).map((q) => q.expr),
      ...(typeof p.query === 'string' && p.query.trim().length > 0 ? [p.query] : []),
    ])
    .filter(Boolean);
  const variables = (currentDash?.variables ?? []).map((v) => ({
    name: v.name,
    value: v.current,
  }));

  const result = await ctx.alertRuleAgent.generate(prompt, {
    dashboardId,
    dashboardTitle: currentDash?.title,
    existingQueries: existingQueries.length > 0 ? existingQueries : undefined,
    variables: variables.length > 0 ? variables : undefined,
  });
  const generated = result.rule;

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
        { err: err instanceof Error ? err.message : String(err), tool: 'create_alert_rule' },
        'alertRuleStore lookup failed during upsert — re-throwing to avoid silent duplicate creation',
      );
      throw err;
    }
    const match = scopedList?.find((r) => r.name === generated.name);
    if (match) {
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
    // Same reason as dashboard.create / investigation.create: the list
    // route filters by workspaceId, so an un-scoped row is invisible
    // even though it's in the store.
    rule = await ctx.alertRuleStore.create(
      withWorkspaceScope(ctx.identity, {
        name: generated.name,
        description: generated.description,
        originalPrompt: prompt,
        condition: generated.condition,
        evaluationIntervalSec: generated.evaluationIntervalSec,
        severity: generated.severity,
        labels: { ...generated.labels, ...(dashboardId ? { dashboardId } : {}) },
        createdBy: 'llm',
      }),
    ) as Record<string, unknown>;
  }

  const rc = rule.condition as Record<string, unknown>;
  const verb = isUpdate ? 'Updated' : 'Created';
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
  const observationText = `${verb} alert rule "${rule.name}" (id: ${rule.id ?? 'unknown'}, ${rule.severity}, evaluating every ${rule.evaluationIntervalSec}s). Rule: ${rc.query} ${rc.operator} ${rc.threshold} for ${rc.forDurationSec}s.`;
  ctx.sendEvent({ type: 'tool_result', tool: 'create_alert_rule', summary: `Alert rule "${rule.name}" ${verb.toLowerCase()}`, success: true });
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'create_alert_rule', summary: observationText }));
  return observationText;
}

// TODO: migrate to withToolEventBoundary
export async function handleModifyAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = String(args.ruleId ?? '');
  const patch = (args.patch ?? args) as Record<string, unknown>;
  if (!ruleId) return 'Error: ruleId is required for modify_alert_rule.';
  if (!ctx.alertRuleStore.update) return 'Error: alert rule store does not support updates.';
  if (!ctx.alertRuleStore.findById) return 'Error: alert rule store does not support findById.';

  ctx.sendEvent({ type: 'tool_call', tool: 'modify_alert_rule', args: { ruleId, patch }, displayText: `Updating alert rule ${ruleId}...` });

  const existingRule = await ctx.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined;
  if (!existingRule) return `Error: alert rule ${ruleId} not found.`;

  // RBAC: derive the rule's folder UID and require alert.rules:write on it.
  // The pre-dispatch tool gate already runs, but defense-in-depth here keeps
  // the handler safe if the gate is ever bypassed (e.g. internal callers).
  const allowed = await evalAlertRuleWrite(ctx, 'alert.rules:write', ruleId);
  if (!allowed) {
    const msg = `Error: not authorized to modify alert rule ${ruleId}.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'modify_alert_rule', summary: msg, success: false });
    return msg;
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
  const observationText = `Updated "${updatedRuleName}"${thresholdText}${operatorText}.`;
  ctx.sendEvent({ type: 'tool_result', tool: 'modify_alert_rule', summary: observationText, success: true });
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'modify_alert_rule', summary: observationText }));
  return observationText;
}

// TODO: migrate to withToolEventBoundary
export async function handleDeleteAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = String(args.ruleId ?? '');
  if (!ruleId) return 'Error: ruleId is required for delete_alert_rule.';

  ctx.sendEvent({ type: 'tool_call', tool: 'delete_alert_rule', args: { ruleId }, displayText: `Deleting alert rule ${ruleId}...` });

  if (!ctx.alertRuleStore.delete) {
    const msg = 'Error: alert rule store does not support delete.';
    ctx.sendEvent({ type: 'tool_result', tool: 'delete_alert_rule', summary: msg, success: false });
    return msg;
  }

  const existingRule = ctx.alertRuleStore.findById
    ? await ctx.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined
    : undefined;

  // RBAC: same guard as modify — defense-in-depth in case the pre-dispatch
  // tool gate is bypassed by an internal caller.
  const allowed = await evalAlertRuleWrite(ctx, 'alert.rules:delete', ruleId);
  if (!allowed) {
    const msg = `Error: not authorized to delete alert rule ${ruleId}.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'delete_alert_rule', summary: msg, success: false });
    return msg;
  }

  await ctx.alertRuleStore.delete(ruleId);

  ctx.pushConversationAction({ type: 'delete_alert_rule', ruleId });

  const deletedRuleName = String(existingRule?.name ?? 'the alert rule');
  const observationText = `Deleted "${deletedRuleName}".`;
  ctx.sendEvent({ type: 'tool_result', tool: 'delete_alert_rule', summary: observationText, success: true });
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'delete_alert_rule', summary: observationText }));
  return observationText;
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
    tool: 'alert_rule.list',
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
      ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.list', summary: msg, success: true });
      return msg;
    }
    const lines = filtered.map((r) => {
      const c = r.condition ?? ({} as Record<string, unknown>);
      return `- [${r.id}] "${r.name}" (${r.severity}) — ${c.query ?? ''} ${c.operator ?? ''} ${c.threshold ?? ''}`;
    });
    const summary = `${filtered.length} alert rule(s)${filter ? ` matching "${filter}"` : ''}:\n${lines.join('\n')}`;
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'alert_rule.list',
      summary: `${filtered.length} alert rules found`,
      success: true,
    });
    return summary;
  } catch (err) {
    const msg = `Failed to list alert rules: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.list', summary: msg, success: false });
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
    tool: 'alert_rule.history',
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
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.history', summary: msg, success: false });
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
      tool: 'alert_rule.history',
      summary: `${annotations.length} alert events`,
      success: true,
    });
    return summary;
  } catch (err) {
    const msg = `Failed to load alert history: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.history', summary: msg, success: false });
    return msg;
  }
}
