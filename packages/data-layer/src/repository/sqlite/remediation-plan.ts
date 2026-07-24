/**
 * SQLite implementation of `IRemediationPlanRepository`.
 *
 * Phase 3 of `docs/design/auto-remediation.md`. JSON columns are stored as
 * TEXT and parsed in code (matches the surrounding sqlite-repo pattern;
 * keeps the schema dialect-portable).
 */

import { sql, type SQL } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { nowIso, uid } from './instance-shared.js';
import type {
  IRemediationPlanRepository,
  ListRemediationPlansOptions,
  NewRemediationPlan,
  NewRemediationPlanStep,
  RemediationPlan,
  RemediationPlanPatch,
  RemediationPlanStep,
  RemediationPlanStepPatch,
  RemediationPlanStepStatus,
  RemediationPlanStatus,
  RemediationPlanVerificationStatus,
} from '../types/remediation-plan.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface PlanRow {
  id: string;
  org_id: string;
  investigation_id: string;
  rescue_for_plan_id: string | null;
  summary: string;
  status: string;
  linked_alert_rule_id: string | null;
  target_object: string | null;
  validation_method: string | null;
  verification_status: string;
  verification_started_at: string | null;
  verification_deadline_at: string | null;
  verification_evidence_json: string | null;
  continuation_investigation_id: string | null;
  auto_edit: number;
  approval_request_id: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

interface StepRow {
  id: string;
  plan_id: string;
  ordinal: number;
  kind: string;
  command_text: string;
  params_json: string;
  dry_run_text: string | null;
  risk_note: string | null;
  continue_on_error: number;
  status: string;
  approval_request_id: string | null;
  executed_at: string | null;
  output_text: string | null;
  error_text: string | null;
}

function parseParams(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Persisted JSON should always parse; corruption is operator-visible.
    throw new Error(`[RemediationPlanRepository] params_json parse failed: ${raw.slice(0, 64)}`);
  }
}

function parseNullableObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    throw new Error(`[RemediationPlanRepository] verification_evidence_json parse failed: ${raw.slice(0, 64)}`);
  }
}

function rowToStep(row: StepRow): RemediationPlanStep {
  return {
    id: row.id,
    planId: row.plan_id,
    ordinal: row.ordinal,
    kind: row.kind,
    commandText: row.command_text,
    paramsJson: parseParams(row.params_json),
    dryRunText: row.dry_run_text,
    riskNote: row.risk_note,
    continueOnError: row.continue_on_error === 1,
    status: row.status as RemediationPlanStepStatus,
    approvalRequestId: row.approval_request_id,
    executedAt: row.executed_at,
    outputText: row.output_text,
    errorText: row.error_text,
  };
}

function rowToPlan(row: PlanRow, steps: RemediationPlanStep[]): RemediationPlan {
  return {
    id: row.id,
    orgId: row.org_id,
    investigationId: row.investigation_id,
    rescueForPlanId: row.rescue_for_plan_id,
    summary: row.summary,
    status: row.status as RemediationPlanStatus,
    linkedAlertRuleId: row.linked_alert_rule_id,
    targetObject: row.target_object,
    validationMethod: row.validation_method,
    verificationStatus: row.verification_status as RemediationPlanVerificationStatus,
    verificationStartedAt: row.verification_started_at,
    verificationDeadlineAt: row.verification_deadline_at,
    verificationEvidenceJson: parseNullableObject(row.verification_evidence_json),
    continuationInvestigationId: row.continuation_investigation_id,
    autoEdit: row.auto_edit === 1,
    approvalRequestId: row.approval_request_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    steps,
  };
}

export class SqliteRemediationPlanRepository implements IRemediationPlanRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewRemediationPlan): Promise<RemediationPlan> {
    const id = input.id ?? `plan-${uid()}`;
    const now = nowIso();
    const expiresAt =
      input.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
    const status = input.status ?? 'pending_approval';
    const verificationStatus = input.verificationStatus ?? 'not_started';
    const autoEdit = input.autoEdit ? 1 : 0;

    // Atomic plan + steps insert via the QueryClient transaction primitive.
    return this.db.withTransaction(async (tx) => {
      await tx.run(sql`
        INSERT INTO remediation_plan (
          id, org_id, investigation_id, rescue_for_plan_id, summary, status,
          linked_alert_rule_id, target_object, validation_method,
          verification_status, verification_started_at, verification_deadline_at,
          verification_evidence_json, continuation_investigation_id,
          auto_edit, approval_request_id, created_by, created_at, expires_at,
          resolved_at, resolved_by
        ) VALUES (
          ${id},
          ${input.orgId},
          ${input.investigationId},
          ${input.rescueForPlanId ?? null},
          ${input.summary},
          ${status},
          ${input.linkedAlertRuleId ?? null},
          ${input.targetObject ?? null},
          ${input.validationMethod ?? null},
          ${verificationStatus},
          ${input.verificationStartedAt ?? null},
          ${input.verificationDeadlineAt ?? null},
          ${input.verificationEvidenceJson ? JSON.stringify(input.verificationEvidenceJson) : null},
          ${input.continuationInvestigationId ?? null},
          ${autoEdit},
          ${input.approvalRequestId ?? null},
          ${input.createdBy},
          ${now},
          ${expiresAt},
          ${null},
          ${null}
        )
      `);

      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i] as NewRemediationPlanStep;
        const stepId = `step-${uid()}`;
        await tx.run(sql`
          INSERT INTO remediation_plan_step (
            id, plan_id, ordinal, kind, command_text, params_json,
            dry_run_text, risk_note, continue_on_error, status,
            approval_request_id, executed_at, output_text, error_text
          ) VALUES (
            ${stepId},
            ${id},
            ${i},
            ${step.kind},
            ${step.commandText},
            ${JSON.stringify(step.paramsJson ?? {})},
            ${step.dryRunText ?? null},
            ${step.riskNote ?? null},
            ${step.continueOnError ? 1 : 0},
            ${'pending'},
            ${null},
            ${null},
            ${null},
            ${null}
          )
        `);
      }

      const planRows = await tx.all<PlanRow>(
        sql`SELECT * FROM remediation_plan WHERE id = ${id}`,
      );
      const stepRows = await tx.all<StepRow>(
        sql`SELECT * FROM remediation_plan_step WHERE plan_id = ${id} ORDER BY ordinal`,
      );
      const planRow = planRows[0];
      if (!planRow) {
        throw new Error(`[RemediationPlanRepository] create: row ${id} not found after insert`);
      }
      return rowToPlan(planRow, stepRows.map(rowToStep));
    });
  }

  async findByIdInOrg(orgId: string, id: string): Promise<RemediationPlan | null> {
    const rows = this.db.all<PlanRow>(sql`
      SELECT * FROM remediation_plan WHERE org_id = ${orgId} AND id = ${id}
    `);
    return this.planFromRows(rows);
  }

  async findById(id: string): Promise<RemediationPlan | null> {
    const rows = this.db.all<PlanRow>(sql`
      SELECT * FROM remediation_plan WHERE id = ${id}
    `);
    return this.planFromRows(rows);
  }

  async findByApprovalRequestId(approvalRequestId: string): Promise<RemediationPlan | null> {
    const rows = this.db.all<PlanRow>(sql`
      SELECT DISTINCT p.*
      FROM remediation_plan p
      LEFT JOIN remediation_plan_step s ON s.plan_id = p.id
      WHERE p.approval_request_id = ${approvalRequestId}
         OR s.approval_request_id = ${approvalRequestId}
      LIMIT 1
    `);
    return this.planFromRows(rows);
  }

  private planFromRows(rows: PlanRow[]): RemediationPlan | null {
    const row = rows[0];
    if (!row) return null;
    const stepRows = this.db.all<StepRow>(sql`
      SELECT * FROM remediation_plan_step WHERE plan_id = ${row.id} ORDER BY ordinal
    `);
    return rowToPlan(row, stepRows.map(rowToStep));
  }

  async listByOrg(
    orgId: string,
    opts: ListRemediationPlansOptions = {},
  ): Promise<RemediationPlan[]> {
    const wheres: SQL[] = [sql`org_id = ${orgId}`];
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (statuses.length > 0) {
        const list = sql.join(statuses.map((s) => sql`${s}`), sql`, `);
        wheres.push(sql`status IN (${list})`);
      }
    }
    if (opts.verificationStatus) {
      const statuses = Array.isArray(opts.verificationStatus) ? opts.verificationStatus : [opts.verificationStatus];
      if (statuses.length > 0) {
        const list = sql.join(statuses.map((s) => sql`${s}`), sql`, `);
        wheres.push(sql`verification_status IN (${list})`);
      }
    }
    if (opts.investigationId) {
      wheres.push(sql`investigation_id = ${opts.investigationId}`);
    }
    if (opts.rescueForPlanId === null) {
      wheres.push(sql`rescue_for_plan_id IS NULL`);
    } else if (typeof opts.rescueForPlanId === 'string') {
      wheres.push(sql`rescue_for_plan_id = ${opts.rescueForPlanId}`);
    }
    const whereClause = sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `);
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    const planRows = this.db.all<PlanRow>(sql`
      SELECT * FROM remediation_plan
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    if (planRows.length === 0) return [];

    // Fetch all matching steps in one query, then group.
    const planIds = planRows.map((p) => p.id);
    const idList = sql.join(planIds.map((p) => sql`${p}`), sql`, `);
    const stepRows = this.db.all<StepRow>(sql`
      SELECT * FROM remediation_plan_step
      WHERE plan_id IN (${idList})
      ORDER BY plan_id, ordinal
    `);
    const stepsByPlan = new Map<string, RemediationPlanStep[]>();
    for (const sr of stepRows) {
      const arr = stepsByPlan.get(sr.plan_id) ?? [];
      arr.push(rowToStep(sr));
      stepsByPlan.set(sr.plan_id, arr);
    }
    return planRows.map((pr) => rowToPlan(pr, stepsByPlan.get(pr.id) ?? []));
  }

  async listWaitingVerification(limit = 100): Promise<RemediationPlan[]> {
    const planRows = this.db.all<PlanRow>(sql`
      SELECT * FROM remediation_plan
      WHERE verification_status = 'waiting'
      ORDER BY verification_deadline_at ASC, created_at ASC
      LIMIT ${limit}
    `);
    if (planRows.length === 0) return [];

    const planIds = planRows.map((p) => p.id);
    const idList = sql.join(planIds.map((p) => sql`${p}`), sql`, `);
    const stepRows = this.db.all<StepRow>(sql`
      SELECT * FROM remediation_plan_step
      WHERE plan_id IN (${idList})
      ORDER BY plan_id, ordinal
    `);
    const stepsByPlan = new Map<string, RemediationPlanStep[]>();
    for (const sr of stepRows) {
      const arr = stepsByPlan.get(sr.plan_id) ?? [];
      arr.push(rowToStep(sr));
      stepsByPlan.set(sr.plan_id, arr);
    }
    return planRows.map((pr) => rowToPlan(pr, stepsByPlan.get(pr.id) ?? []));
  }

  async listAppliedAwaitingVerification(limit = 100): Promise<RemediationPlan[]> {
    const planRows = this.db.all<PlanRow>(sql`
      SELECT * FROM remediation_plan
      WHERE status = 'applied' AND verification_status = 'not_started'
      ORDER BY created_at ASC
      LIMIT ${limit}
    `);
    if (planRows.length === 0) return [];

    const planIds = planRows.map((p) => p.id);
    const idList = sql.join(planIds.map((p) => sql`${p}`), sql`, `);
    const stepRows = this.db.all<StepRow>(sql`
      SELECT * FROM remediation_plan_step
      WHERE plan_id IN (${idList})
      ORDER BY plan_id, ordinal
    `);
    const stepsByPlan = new Map<string, RemediationPlanStep[]>();
    for (const sr of stepRows) {
      const arr = stepsByPlan.get(sr.plan_id) ?? [];
      arr.push(rowToStep(sr));
      stepsByPlan.set(sr.plan_id, arr);
    }
    return planRows.map((pr) => rowToPlan(pr, stepsByPlan.get(pr.id) ?? []));
  }

  async updatePlan(
    orgId: string,
    id: string,
    patch: RemediationPlanPatch,
  ): Promise<RemediationPlan | null> {
    const existing = await this.findByIdInOrg(orgId, id);
    if (!existing) return null;

    const next = {
      status: patch.status ?? existing.status,
      linkedAlertRuleId:
        patch.linkedAlertRuleId !== undefined ? patch.linkedAlertRuleId : existing.linkedAlertRuleId,
      targetObject: patch.targetObject !== undefined ? patch.targetObject : existing.targetObject,
      validationMethod:
        patch.validationMethod !== undefined ? patch.validationMethod : existing.validationMethod,
      verificationStatus:
        patch.verificationStatus !== undefined ? patch.verificationStatus : existing.verificationStatus,
      verificationStartedAt:
        patch.verificationStartedAt !== undefined ? patch.verificationStartedAt : existing.verificationStartedAt,
      verificationDeadlineAt:
        patch.verificationDeadlineAt !== undefined ? patch.verificationDeadlineAt : existing.verificationDeadlineAt,
      verificationEvidenceJson:
        patch.verificationEvidenceJson !== undefined
          ? patch.verificationEvidenceJson
          : existing.verificationEvidenceJson,
      continuationInvestigationId:
        patch.continuationInvestigationId !== undefined
          ? patch.continuationInvestigationId
          : existing.continuationInvestigationId,
      autoEdit: patch.autoEdit !== undefined ? patch.autoEdit : existing.autoEdit,
      approvalRequestId:
        patch.approvalRequestId !== undefined ? patch.approvalRequestId : existing.approvalRequestId,
      resolvedAt: patch.resolvedAt !== undefined ? patch.resolvedAt : existing.resolvedAt,
      resolvedBy: patch.resolvedBy !== undefined ? patch.resolvedBy : existing.resolvedBy,
    };

    this.db.run(sql`
      UPDATE remediation_plan
      SET status = ${next.status},
          linked_alert_rule_id = ${next.linkedAlertRuleId},
          target_object = ${next.targetObject},
          validation_method = ${next.validationMethod},
          verification_status = ${next.verificationStatus},
          verification_started_at = ${next.verificationStartedAt},
          verification_deadline_at = ${next.verificationDeadlineAt},
          verification_evidence_json = ${next.verificationEvidenceJson ? JSON.stringify(next.verificationEvidenceJson) : null},
          continuation_investigation_id = ${next.continuationInvestigationId},
          auto_edit = ${next.autoEdit ? 1 : 0},
          approval_request_id = ${next.approvalRequestId},
          resolved_at = ${next.resolvedAt},
          resolved_by = ${next.resolvedBy}
      WHERE org_id = ${orgId} AND id = ${id}
    `);
    return this.findByIdInOrg(orgId, id);
  }

  async updateStep(
    planId: string,
    ordinal: number,
    patch: RemediationPlanStepPatch,
  ): Promise<RemediationPlanStep | null> {
    const existing = this.db.all<StepRow>(sql`
      SELECT * FROM remediation_plan_step WHERE plan_id = ${planId} AND ordinal = ${ordinal}
    `)[0];
    if (!existing) return null;

    const next = {
      status: patch.status ?? (existing.status as RemediationPlanStepStatus),
      approvalRequestId:
        patch.approvalRequestId !== undefined ? patch.approvalRequestId : existing.approval_request_id,
      executedAt: patch.executedAt !== undefined ? patch.executedAt : existing.executed_at,
      outputText: patch.outputText !== undefined ? patch.outputText : existing.output_text,
      errorText: patch.errorText !== undefined ? patch.errorText : existing.error_text,
    };

    this.db.run(sql`
      UPDATE remediation_plan_step
      SET status = ${next.status},
          approval_request_id = ${next.approvalRequestId},
          executed_at = ${next.executedAt},
          output_text = ${next.outputText},
          error_text = ${next.errorText}
      WHERE plan_id = ${planId} AND ordinal = ${ordinal}
    `);

    const after = this.db.all<StepRow>(sql`
      SELECT * FROM remediation_plan_step WHERE plan_id = ${planId} AND ordinal = ${ordinal}
    `)[0];
    return after ? rowToStep(after) : null;
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    const existing = await this.findByIdInOrg(orgId, id);
    if (!existing) return false;
    return this.db.withTransaction(async (tx) => {
      await tx.run(sql`DELETE FROM remediation_plan_step WHERE plan_id = ${id}`);
      await tx.run(sql`DELETE FROM remediation_plan WHERE org_id = ${orgId} AND id = ${id}`);
      return true;
    });
  }

  async expireStale(now: string): Promise<number> {
    const stale = this.db.all<{ id: string }>(sql`
      SELECT id FROM remediation_plan
      WHERE status = 'pending_approval' AND expires_at <= ${now}
    `);
    if (stale.length === 0) return 0;
    this.db.run(sql`
      UPDATE remediation_plan
      SET status = 'expired'
      WHERE status = 'pending_approval' AND expires_at <= ${now}
    `);
    return stale.length;
  }
}
