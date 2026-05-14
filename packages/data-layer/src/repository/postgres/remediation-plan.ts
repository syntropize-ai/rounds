/**
 * Postgres implementation of `IRemediationPlanRepository`. Mirrors the
 * SQLite implementation row-for-row; the only differences are the boolean
 * encoding (`true/false` vs. `1/0`) and the use of `pgAll`/`pgRun` /
 * `withTransaction` on the Postgres `DbClient`.
 *
 * Phase 3 of `auto-remediation design notes`.
 */

import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { QueryClient } from '../../db/query-client.js';
import { pgAll, pgRun } from './pg-helpers.js';
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
} from '../types/remediation-plan.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface PlanRow {
  id: string;
  org_id: string;
  investigation_id: string;
  rescue_for_plan_id: string | null;
  summary: string;
  status: string;
  auto_edit: boolean;
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
  params_json: string | Record<string, unknown>;
  dry_run_text: string | null;
  risk_note: string | null;
  continue_on_error: boolean;
  status: string;
  approval_request_id: string | null;
  executed_at: string | null;
  output_text: string | null;
  error_text: string | null;
}

function parseParams(raw: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  // node-postgres returns json/jsonb as parsed objects, but the column is TEXT
  // here so we always get a string. Be tolerant of either.
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(`[RemediationPlanRepository] params_json parse failed: ${raw.slice(0, 64)}`);
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
    continueOnError: Boolean(row.continue_on_error),
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
    autoEdit: Boolean(row.auto_edit),
    approvalRequestId: row.approval_request_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    steps,
  };
}

export class PostgresRemediationPlanRepository implements IRemediationPlanRepository {
  constructor(private readonly db: QueryClient) {}

  async create(input: NewRemediationPlan): Promise<RemediationPlan> {
    const id = input.id ?? `plan-${randomUUID()}`;
    const now = new Date().toISOString();
    const expiresAt =
      input.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
    const status = input.status ?? 'pending_approval';

    return this.db.withTransaction(async (tx) => {
      await tx.run(sql`
        INSERT INTO remediation_plan (
          id, org_id, investigation_id, rescue_for_plan_id, summary, status,
          auto_edit, approval_request_id, created_by, created_at, expires_at,
          resolved_at, resolved_by
        ) VALUES (
          ${id},
          ${input.orgId},
          ${input.investigationId},
          ${input.rescueForPlanId ?? null},
          ${input.summary},
          ${status},
          ${input.autoEdit ?? false},
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
        const stepId = `step-${randomUUID()}`;
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
            ${step.continueOnError ?? false},
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
    const rows = await pgAll<PlanRow>(this.db, sql`
      SELECT * FROM remediation_plan WHERE org_id = ${orgId} AND id = ${id}
    `);
    return this.planFromRows(rows);
  }

  async findById(id: string): Promise<RemediationPlan | null> {
    const rows = await pgAll<PlanRow>(this.db, sql`
      SELECT * FROM remediation_plan WHERE id = ${id}
    `);
    return this.planFromRows(rows);
  }

  async findByApprovalRequestId(approvalRequestId: string): Promise<RemediationPlan | null> {
    const rows = await pgAll<PlanRow>(this.db, sql`
      SELECT DISTINCT p.*
      FROM remediation_plan p
      LEFT JOIN remediation_plan_step s ON s.plan_id = p.id
      WHERE p.approval_request_id = ${approvalRequestId}
         OR s.approval_request_id = ${approvalRequestId}
      LIMIT 1
    `);
    return this.planFromRows(rows);
  }

  private async planFromRows(rows: PlanRow[]): Promise<RemediationPlan | null> {
    const row = rows[0];
    if (!row) return null;
    const stepRows = await pgAll<StepRow>(this.db, sql`
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

    const planRows = await pgAll<PlanRow>(this.db, sql`
      SELECT * FROM remediation_plan
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    if (planRows.length === 0) return [];

    const planIds = planRows.map((p) => p.id);
    const idList = sql.join(planIds.map((p) => sql`${p}`), sql`, `);
    const stepRows = await pgAll<StepRow>(this.db, sql`
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
      autoEdit: patch.autoEdit !== undefined ? patch.autoEdit : existing.autoEdit,
      approvalRequestId:
        patch.approvalRequestId !== undefined ? patch.approvalRequestId : existing.approvalRequestId,
      resolvedAt: patch.resolvedAt !== undefined ? patch.resolvedAt : existing.resolvedAt,
      resolvedBy: patch.resolvedBy !== undefined ? patch.resolvedBy : existing.resolvedBy,
    };

    await pgRun(this.db, sql`
      UPDATE remediation_plan
      SET status = ${next.status},
          auto_edit = ${next.autoEdit},
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
    const rows = await pgAll<StepRow>(this.db, sql`
      SELECT * FROM remediation_plan_step WHERE plan_id = ${planId} AND ordinal = ${ordinal}
    `);
    const existing = rows[0];
    if (!existing) return null;

    const next = {
      status: patch.status ?? (existing.status as RemediationPlanStepStatus),
      approvalRequestId:
        patch.approvalRequestId !== undefined ? patch.approvalRequestId : existing.approval_request_id,
      executedAt: patch.executedAt !== undefined ? patch.executedAt : existing.executed_at,
      outputText: patch.outputText !== undefined ? patch.outputText : existing.output_text,
      errorText: patch.errorText !== undefined ? patch.errorText : existing.error_text,
    };

    await pgRun(this.db, sql`
      UPDATE remediation_plan_step
      SET status = ${next.status},
          approval_request_id = ${next.approvalRequestId},
          executed_at = ${next.executedAt},
          output_text = ${next.outputText},
          error_text = ${next.errorText}
      WHERE plan_id = ${planId} AND ordinal = ${ordinal}
    `);

    const after = await pgAll<StepRow>(this.db, sql`
      SELECT * FROM remediation_plan_step WHERE plan_id = ${planId} AND ordinal = ${ordinal}
    `);
    return after[0] ? rowToStep(after[0]) : null;
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
    const stale = await pgAll<{ id: string }>(this.db, sql`
      SELECT id FROM remediation_plan
      WHERE status = 'pending_approval' AND expires_at <= ${now}
    `);
    if (stale.length === 0) return 0;
    await pgRun(this.db, sql`
      UPDATE remediation_plan
      SET status = 'expired'
      WHERE status = 'pending_approval' AND expires_at <= ${now}
    `);
    return stale.length;
  }
}
