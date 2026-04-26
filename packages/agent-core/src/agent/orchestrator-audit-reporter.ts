import { AuditAction } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { Identity } from '@agentic-obs/common';
import type { AgentDefinition } from './agent-definition.js';
import type { IAuditWriter, PermissionGateResult } from './types-permissions.js';

const log = createLogger('orchestrator');

/** Per-(userId, tool) rate-limit window for `agent.tool_called` audit rows. */
const ALLOW_AUDIT_COOLDOWN_MS = 60_000;

export interface ToolAuditReporterDeps {
  identity: Identity;
  auditWriter?: IAuditWriter;
  agentDef: AgentDefinition;
}

export class ToolAuditReporter {
  private readonly allowAuditAt = new Map<string, number>();

  constructor(private readonly deps: ToolAuditReporterDeps) {}

  /**
   * Persist an audit row for a gated tool call. Allow-path is rate-limited to
   * one row per (identity.userId, tool) per 60s (§D9). Deny-path always writes.
   * Fire-and-forget; writer failures never block the loop.
   */
  async writeToolAudit(
    path: 'allow' | 'denied',
    tool: string,
    args: Record<string, unknown>,
    gateResult: PermissionGateResult,
  ): Promise<void> {
    const writer = this.deps.auditWriter;
    if (!writer) return;

    if (path === 'allow') {
      const key = `${this.deps.identity.userId}:${tool}`;
      const last = this.allowAuditAt.get(key) ?? 0;
      const now = Date.now();
      if (now - last < ALLOW_AUDIT_COOLDOWN_MS) return;
      this.allowAuditAt.set(key, now);
    }

    const targetType = inferTargetType(tool);
    const targetId = inferTargetId(tool, args);
    const action = path === 'allow'
      ? AuditAction.AgentToolCalled
      : AuditAction.AgentToolDenied;
    const outcome: 'success' | 'failure' =
      path === 'allow' ? 'success' : 'failure';

    await writer.log({
      action,
      actorType: this.deps.identity.serviceAccountId ? 'service_account' : 'user',
      actorId: this.deps.identity.serviceAccountId ?? this.deps.identity.userId,
      orgId: this.deps.identity.orgId,
      targetType,
      targetId: targetId ?? null,
      outcome,
      metadata: {
        agent_type: this.deps.agentDef.type,
        tool,
        required_action: gateResult.action ?? null,
        required_scope: gateResult.scope ?? null,
        denied_by: path === 'denied' ? gateResult.reason ?? null : null,
        args_summary: summarizeArgs(args),
      },
    }).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : err, tool, path },
        'agent audit write failed',
      );
    });
  }
}

function inferTargetType(tool: string): string | null {
  if (tool.startsWith('dashboard.')) return 'dashboard';
  if (tool.startsWith('folder.')) return 'folder';
  if (tool.startsWith('investigation.')) return 'investigation';
  if (
    tool.startsWith('metrics.') ||
    tool.startsWith('logs.') ||
    tool === 'datasources.list'
  ) {
    return 'datasource';
  }
  if (tool === 'changes.list_recent') return 'changes';
  if (tool.startsWith('alert_rule.') || tool === 'create_alert_rule' || tool === 'modify_alert_rule' || tool === 'delete_alert_rule') {
    return 'alert_rule';
  }
  if (tool === 'web.search') return 'web_search';
  return null;
}

function inferTargetId(tool: string, args: Record<string, unknown>): string | null {
  if (tool.startsWith('dashboard.')) return pickString(args.dashboardId);
  if (tool.startsWith('investigation.')) return pickString(args.investigationId);
  if (tool.startsWith('folder.')) return pickString(args.folderUid ?? args.parentUid);
  if (tool.startsWith('metrics.') || tool.startsWith('logs.') || tool === 'changes.list_recent') {
    return pickString(args.sourceId ?? args.datasourceId ?? args.datasourceUid);
  }
  if (tool === 'create_alert_rule') return pickString(args.folderUid);
  if (tool === 'modify_alert_rule' || tool === 'delete_alert_rule' || tool === 'alert_rule.history') {
    return pickString(args.ruleId);
  }
  return null;
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length <= 200 ? s : `${s.slice(0, 200)}...`;
  } catch {
    return '[unserializable args]';
  }
}
