/**
 * AlertRuleRepository — SQLite-backed replacement for the in-memory
 * AlertRuleStore (W6 / T6.A3).
 *
 * Backs four related tables from sqlite-schema.ts:
 *   - alert_rules              primary rule entities + lifecycle state
 *   - alert_history            append-only log of state transitions
 *   - alert_silences           active and expired silence windows
 *   - notification_policies    flat notification routing policies
 *
 * Written in the Drizzle-orm `sql` template style used by the W2
 * instance-config repositories: we hand-roll parameterised SQL via
 * `db.all()` / `db.run()` rather than using the query builder. JSON
 * columns (condition, labels, matchers, channels, groupBy) are stored
 * as TEXT and stringified/parsed at this layer with a safe fallback so
 * a corrupt row can never wedge the whole repo.
 *
 * STATE MACHINE — preserved byte-for-byte from AlertRuleStore.transition().
 * For any newState N where N !== oldState:
 *   - one row is appended to alert_history with from/to/value/threshold
 *     and the rule's labels snapshot at transition time
 *   - the rule row is updated with state, stateChangedAt=now, lastEvaluatedAt=now
 *   - N === 'pending'              → pendingSince = now
 *   - N === 'firing'               → lastFiredAt = now, fireCount += 1, pendingSince = NULL
 *   - N === 'normal' || 'resolved' → pendingSince = NULL
 * When newState === oldState, transition() returns the existing rule
 * untouched — NO history row, NO side-effect. This matches the in-memory
 * behavior where the `this.update()` call was skipped for no-op
 * transitions, which means stateChangedAt and lastEvaluatedAt were NOT
 * refreshed for idempotent polls.
 */

import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  AlertRule,
  AlertRuleState,
  AlertHistoryEntry,
  AlertSilence,
  NotificationPolicy,
  SilenceStatus,
} from '@agentic-obs/common';
import type {
  IAlertRuleRepository,
  AlertRuleFindAllOptions,
} from '../interfaces.js';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { nowIso } from './instance-shared.js';

// -- Row shapes (snake_case, matches `SELECT *` output) ----------------

interface RuleRow {
  id: string;
  name: string;
  description: string;
  original_prompt: string | null;
  condition: string;
  evaluation_interval_sec: number;
  severity: string;
  labels: string | null;
  state: string;
  state_changed_at: string;
  pending_since: string | null;
  notification_policy_id: string | null;
  investigation_id: string | null;
  workspace_id: string | null;
  org_id: string;
  created_by: string;
  last_evaluated_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
}

interface HistoryRow {
  id: string;
  rule_id: string;
  rule_name: string;
  from_state: string;
  to_state: string;
  value: number;
  threshold: number;
  timestamp: string;
  labels: string;
}

interface SilenceRow {
  id: string;
  matchers: string;
  starts_at: string;
  ends_at: string;
  comment: string;
  created_by: string;
  created_at: string;
}

interface PolicyRow {
  id: string;
  name: string;
  matchers: string;
  channels: string;
  group_by: string | null;
  group_wait_sec: number | null;
  group_interval_sec: number | null;
  repeat_interval_sec: number | null;
  created_at: string;
  updated_at: string;
}

// -- JSON helpers -----------------------------------------------------

/**
 * Parse a JSON column with a fallback. A corrupt row must not wedge the
 * repo — we log nothing here (route layer will surface the problem) and
 * return the default shape so callers get a well-formed object.
 */
function parseJsonOr<T>(raw: string | null | undefined, dflt: T): T {
  if (raw === null || raw === undefined || raw === '') return dflt;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return dflt;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function stringifyJsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

// -- Row → domain mappers ---------------------------------------------

function rowToRule(r: RuleRow): AlertRule {
  const labels = parseJsonOr<Record<string, string> | null>(r.labels, null);
  const rule: AlertRule = {
    id: r.id,
    name: r.name,
    description: r.description,
    condition: parseJsonOr<AlertRule['condition']>(r.condition, {
      query: '',
      operator: '>',
      threshold: 0,
      forDurationSec: 0,
    }),
    evaluationIntervalSec: r.evaluation_interval_sec,
    severity: r.severity as AlertRule['severity'],
    state: r.state as AlertRuleState,
    stateChangedAt: r.state_changed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    fireCount: r.fire_count,
  };
  if (r.original_prompt !== null) rule.originalPrompt = r.original_prompt;
  if (labels !== null) rule.labels = labels;
  if (r.pending_since !== null) rule.pendingSince = r.pending_since;
  if (r.notification_policy_id !== null) rule.notificationPolicyId = r.notification_policy_id;
  if (r.investigation_id !== null) rule.investigationId = r.investigation_id;
  if (r.workspace_id !== null) rule.workspaceId = r.workspace_id;
  if (r.last_evaluated_at !== null) rule.lastEvaluatedAt = r.last_evaluated_at;
  if (r.last_fired_at !== null) rule.lastFiredAt = r.last_fired_at;
  return rule;
}

function rowToHistoryEntry(r: HistoryRow): AlertHistoryEntry {
  return {
    id: r.id,
    ruleId: r.rule_id,
    ruleName: r.rule_name,
    fromState: r.from_state as AlertRuleState,
    toState: r.to_state as AlertRuleState,
    value: r.value,
    threshold: r.threshold,
    timestamp: r.timestamp,
    labels: parseJsonOr<Record<string, string>>(r.labels, {}),
  };
}

function computeSilenceStatus(silence: { startsAt: string; endsAt: string }): SilenceStatus {
  const now = nowIso();
  if (silence.endsAt < now) return 'expired';
  if (silence.startsAt > now) return 'pending';
  return 'active';
}

function rowToSilence(r: SilenceRow): AlertSilence {
  const base = {
    id: r.id,
    matchers: parseJsonOr<AlertSilence['matchers']>(r.matchers, []),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    comment: r.comment,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
  return { ...base, status: computeSilenceStatus(base) };
}

function rowToPolicy(r: PolicyRow): NotificationPolicy {
  const p: NotificationPolicy = {
    id: r.id,
    name: r.name,
    matchers: parseJsonOr<NotificationPolicy['matchers']>(r.matchers, []),
    channels: parseJsonOr<NotificationPolicy['channels']>(r.channels, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.group_by !== null) p.groupBy = parseJsonOr<string[]>(r.group_by, []);
  if (r.group_wait_sec !== null) p.groupWaitSec = r.group_wait_sec;
  if (r.group_interval_sec !== null) p.groupIntervalSec = r.group_interval_sec;
  if (r.repeat_interval_sec !== null) p.repeatIntervalSec = r.repeat_interval_sec;
  return p;
}

// -- Repository -------------------------------------------------------

export class AlertRuleRepository implements IAlertRuleRepository {
  constructor(private readonly db: SqliteClient) {}

  // -- Rules ----------------------------------------------------------

  async create(
    data: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>,
  ): Promise<AlertRule> {
    const id = `alert_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO alert_rules (
        id, name, description, original_prompt, condition,
        evaluation_interval_sec, severity, labels, state,
        state_changed_at, pending_since, notification_policy_id,
        investigation_id, workspace_id, folder_uid, org_id, created_by,
        last_evaluated_at, last_fired_at, fire_count,
        created_at, updated_at
      ) VALUES (
        ${id},
        ${data.name},
        ${data.description},
        ${data.originalPrompt ?? null},
        ${stringifyJson(data.condition)},
        ${data.evaluationIntervalSec},
        ${data.severity},
        ${stringifyJsonOrNull(data.labels)},
        ${'normal'},
        ${now},
        ${null},
        ${data.notificationPolicyId ?? null},
        ${data.investigationId ?? null},
        ${data.workspaceId ?? null},
        ${data.folderUid ?? null},
        ${'org_main'},
        ${data.createdBy},
        ${data.lastEvaluatedAt ?? null},
        ${data.lastFiredAt ?? null},
        ${0},
        ${now},
        ${now}
      )
    `);
    const saved = await this.findById(id);
    if (!saved) throw new Error(`[AlertRuleRepository] create: row ${id} not found after insert`);
    return saved;
  }

  async findById(id: string): Promise<AlertRule | undefined> {
    const rows = this.db.all<RuleRow>(sql`SELECT * FROM alert_rules WHERE id = ${id}`);
    return rows[0] ? rowToRule(rows[0]) : undefined;
  }

  /**
   * Folder-uid lookup used by the RBAC alert-rules resolver to cascade a
   * grant on a folder's scope to any alert rule it contains. Org-scoped so
   * one org can't reach into another's row.
   */
  async getFolderUid(orgId: string, ruleId: string): Promise<string | null> {
    const rows = this.db.all<{ folder_uid: string | null }>(
      sql`SELECT folder_uid FROM alert_rules WHERE org_id = ${orgId} AND id = ${ruleId} LIMIT 1`,
    );
    return rows[0]?.folder_uid ?? null;
  }

  async findAll(filter: AlertRuleFindAllOptions = {}): Promise<{ list: AlertRule[]; total: number }> {
    const wheres: SQL[] = [];
    if (filter.state) wheres.push(sql`state = ${filter.state}`);
    if (filter.severity) wheres.push(sql`severity = ${filter.severity}`);
    const whereClause = wheres.length
      ? sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `)
      : sql``;

    let rows = this.db.all<RuleRow>(sql`
      SELECT * FROM alert_rules ${whereClause}
      ORDER BY updated_at DESC
    `);

    // In-memory search mirrors the old store (name / description / label values).
    if (filter.search) {
      const q = filter.search.toLowerCase();
      rows = rows.filter((r) => {
        const labels = parseJsonOr<Record<string, string>>(r.labels, {});
        return (
          r.name.toLowerCase().includes(q)
          || r.description.toLowerCase().includes(q)
          || Object.values(labels).some((v) => v.toLowerCase().includes(q))
        );
      });
    }

    const total = rows.length;
    if (filter.offset) rows = rows.slice(filter.offset);
    if (filter.limit) rows = rows.slice(0, filter.limit);

    return { list: rows.map(rowToRule), total };
  }

  async findByWorkspace(workspaceId: string): Promise<AlertRule[]> {
    const rows = this.db.all<RuleRow>(
      sql`SELECT * FROM alert_rules WHERE workspace_id = ${workspaceId}`,
    );
    return rows.map(rowToRule);
  }

  async update(
    id: string,
    patch: Partial<Omit<AlertRule, 'id' | 'createdAt'>>,
  ): Promise<AlertRule | undefined> {
    const existing = await this.findById(id);
    if (!existing) return undefined;

    // Merge: `undefined` in the patch is treated as "clear the field"
    // for optional columns — matches the in-memory store which assigns
    // `patch.pendingSince = undefined` in transition() to clear it.
    const hasKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(patch, k);

    const merged = {
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      originalPrompt: hasKey('originalPrompt') ? patch.originalPrompt ?? null : existing.originalPrompt ?? null,
      condition: patch.condition ?? existing.condition,
      evaluationIntervalSec: patch.evaluationIntervalSec ?? existing.evaluationIntervalSec,
      severity: patch.severity ?? existing.severity,
      labels: hasKey('labels') ? patch.labels ?? null : existing.labels ?? null,
      state: patch.state ?? existing.state,
      stateChangedAt: patch.stateChangedAt ?? existing.stateChangedAt,
      pendingSince: hasKey('pendingSince') ? patch.pendingSince ?? null : existing.pendingSince ?? null,
      notificationPolicyId: hasKey('notificationPolicyId')
        ? patch.notificationPolicyId ?? null
        : existing.notificationPolicyId ?? null,
      investigationId: hasKey('investigationId')
        ? patch.investigationId ?? null
        : existing.investigationId ?? null,
      workspaceId: hasKey('workspaceId') ? patch.workspaceId ?? null : existing.workspaceId ?? null,
      lastEvaluatedAt: hasKey('lastEvaluatedAt')
        ? patch.lastEvaluatedAt ?? null
        : existing.lastEvaluatedAt ?? null,
      lastFiredAt: hasKey('lastFiredAt') ? patch.lastFiredAt ?? null : existing.lastFiredAt ?? null,
      fireCount: patch.fireCount ?? existing.fireCount,
    };

    const now = nowIso();
    this.db.run(sql`
      UPDATE alert_rules SET
        name                    = ${merged.name},
        description             = ${merged.description},
        original_prompt         = ${merged.originalPrompt},
        condition               = ${stringifyJson(merged.condition)},
        evaluation_interval_sec = ${merged.evaluationIntervalSec},
        severity                = ${merged.severity},
        labels                  = ${stringifyJsonOrNull(merged.labels)},
        state                   = ${merged.state},
        state_changed_at        = ${merged.stateChangedAt},
        pending_since           = ${merged.pendingSince},
        notification_policy_id  = ${merged.notificationPolicyId},
        investigation_id        = ${merged.investigationId},
        workspace_id            = ${merged.workspaceId},
        last_evaluated_at       = ${merged.lastEvaluatedAt},
        last_fired_at           = ${merged.lastFiredAt},
        fire_count              = ${merged.fireCount},
        updated_at              = ${now}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM alert_rules WHERE id = ${id}`);
    return true;
  }

  async transition(
    id: string,
    newState: AlertRuleState,
    value?: number,
  ): Promise<AlertRule | undefined> {
    const rule = await this.findById(id);
    if (!rule) return undefined;
    const oldState = rule.state;
    // No-op transition: return the rule untouched. Mirrors the in-memory
    // store which early-returned before appending history or updating
    // stateChangedAt/lastEvaluatedAt for idempotent polls.
    if (oldState === newState) return rule;

    const now = nowIso();

    // 1) append history row
    this.db.run(sql`
      INSERT INTO alert_history (
        id, rule_id, rule_name, from_state, to_state,
        value, threshold, timestamp, labels
      ) VALUES (
        ${randomUUID()},
        ${id},
        ${rule.name},
        ${oldState},
        ${newState},
        ${value ?? 0},
        ${rule.condition.threshold},
        ${now},
        ${stringifyJson(rule.labels ?? {})}
      )
    `);

    // 2) apply state-specific side-effects exactly as the old store did
    const patch: Partial<AlertRule> = {
      state: newState,
      stateChangedAt: now,
      lastEvaluatedAt: now,
    };
    if (newState === 'pending') patch.pendingSince = now;
    if (newState === 'firing') {
      patch.lastFiredAt = now;
      patch.fireCount = rule.fireCount + 1;
      patch.pendingSince = undefined;
    }
    if (newState === 'normal' || newState === 'resolved') {
      patch.pendingSince = undefined;
    }

    return this.update(id, patch);
  }

  // -- History --------------------------------------------------------

  async getHistory(ruleId: string, limit = 50): Promise<AlertHistoryEntry[]> {
    const rows = this.db.all<HistoryRow>(sql`
      SELECT * FROM alert_history
      WHERE rule_id = ${ruleId}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `);
    return rows.map(rowToHistoryEntry);
  }

  async getAllHistory(limit = 100): Promise<AlertHistoryEntry[]> {
    const rows = this.db.all<HistoryRow>(sql`
      SELECT * FROM alert_history
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `);
    return rows.map(rowToHistoryEntry);
  }

  // -- Silences -------------------------------------------------------

  async createSilence(data: Omit<AlertSilence, 'id' | 'createdAt'>): Promise<AlertSilence> {
    const id = `silence_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO alert_silences (
        id, matchers, starts_at, ends_at, comment, created_by, created_at
      ) VALUES (
        ${id},
        ${stringifyJson(data.matchers)},
        ${data.startsAt},
        ${data.endsAt},
        ${data.comment},
        ${data.createdBy},
        ${now}
      )
    `);
    const rows = this.db.all<SilenceRow>(sql`SELECT * FROM alert_silences WHERE id = ${id}`);
    if (!rows[0])
      throw new Error(`[AlertRuleRepository] createSilence: row ${id} not found after insert`);
    return rowToSilence(rows[0]);
  }

  async findSilences(): Promise<AlertSilence[]> {
    const now = nowIso();
    const rows = this.db.all<SilenceRow>(
      sql`SELECT * FROM alert_silences WHERE ends_at > ${now}`,
    );
    return rows.map(rowToSilence);
  }

  async findAllSilencesIncludingExpired(): Promise<AlertSilence[]> {
    const rows = this.db.all<SilenceRow>(sql`SELECT * FROM alert_silences`);
    return rows.map(rowToSilence);
  }

  async updateSilence(
    id: string,
    patch: Partial<Omit<AlertSilence, 'id' | 'createdAt'>>,
  ): Promise<AlertSilence | undefined> {
    const rows = this.db.all<SilenceRow>(sql`SELECT * FROM alert_silences WHERE id = ${id}`);
    const current = rows[0];
    if (!current) return undefined;
    const merged = {
      matchers: patch.matchers !== undefined
        ? stringifyJson(patch.matchers)
        : current.matchers,
      startsAt: patch.startsAt ?? current.starts_at,
      endsAt: patch.endsAt ?? current.ends_at,
      comment: patch.comment ?? current.comment,
      createdBy: patch.createdBy ?? current.created_by,
    };
    this.db.run(sql`
      UPDATE alert_silences SET
        matchers   = ${merged.matchers},
        starts_at  = ${merged.startsAt},
        ends_at    = ${merged.endsAt},
        comment    = ${merged.comment},
        created_by = ${merged.createdBy}
      WHERE id = ${id}
    `);
    const updated = this.db.all<SilenceRow>(sql`SELECT * FROM alert_silences WHERE id = ${id}`);
    return updated[0] ? rowToSilence(updated[0]) : undefined;
  }

  async deleteSilence(id: string): Promise<boolean> {
    const rows = this.db.all<SilenceRow>(sql`SELECT id FROM alert_silences WHERE id = ${id}`);
    if (rows.length === 0) return false;
    this.db.run(sql`DELETE FROM alert_silences WHERE id = ${id}`);
    return true;
  }

  // -- Notification Policies (flat) -----------------------------------

  async createPolicy(
    data: Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationPolicy> {
    const id = `policy_${randomUUID().slice(0, 12)}`;
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO notification_policies (
        id, name, matchers, channels, group_by,
        group_wait_sec, group_interval_sec, repeat_interval_sec,
        created_at, updated_at
      ) VALUES (
        ${id},
        ${data.name},
        ${stringifyJson(data.matchers)},
        ${stringifyJson(data.channels)},
        ${stringifyJsonOrNull(data.groupBy)},
        ${data.groupWaitSec ?? null},
        ${data.groupIntervalSec ?? null},
        ${data.repeatIntervalSec ?? null},
        ${now},
        ${now}
      )
    `);
    const saved = await this.findPolicyById(id);
    if (!saved)
      throw new Error(`[AlertRuleRepository] createPolicy: row ${id} not found after insert`);
    return saved;
  }

  async findAllPolicies(): Promise<NotificationPolicy[]> {
    const rows = this.db.all<PolicyRow>(sql`SELECT * FROM notification_policies`);
    return rows.map(rowToPolicy);
  }

  async findPolicyById(id: string): Promise<NotificationPolicy | undefined> {
    const rows = this.db.all<PolicyRow>(
      sql`SELECT * FROM notification_policies WHERE id = ${id}`,
    );
    return rows[0] ? rowToPolicy(rows[0]) : undefined;
  }

  async updatePolicy(
    id: string,
    patch: Partial<Omit<NotificationPolicy, 'id' | 'createdAt'>>,
  ): Promise<NotificationPolicy | undefined> {
    const existing = await this.findPolicyById(id);
    if (!existing) return undefined;
    const hasKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(patch, k);
    const merged = {
      name: patch.name ?? existing.name,
      matchers: patch.matchers ?? existing.matchers,
      channels: patch.channels ?? existing.channels,
      groupBy: hasKey('groupBy') ? patch.groupBy : existing.groupBy,
      groupWaitSec: hasKey('groupWaitSec') ? patch.groupWaitSec : existing.groupWaitSec,
      groupIntervalSec: hasKey('groupIntervalSec') ? patch.groupIntervalSec : existing.groupIntervalSec,
      repeatIntervalSec: hasKey('repeatIntervalSec') ? patch.repeatIntervalSec : existing.repeatIntervalSec,
    };
    const now = nowIso();
    this.db.run(sql`
      UPDATE notification_policies SET
        name                = ${merged.name},
        matchers            = ${stringifyJson(merged.matchers)},
        channels            = ${stringifyJson(merged.channels)},
        group_by            = ${stringifyJsonOrNull(merged.groupBy)},
        group_wait_sec      = ${merged.groupWaitSec ?? null},
        group_interval_sec  = ${merged.groupIntervalSec ?? null},
        repeat_interval_sec = ${merged.repeatIntervalSec ?? null},
        updated_at          = ${now}
      WHERE id = ${id}
    `);
    return this.findPolicyById(id);
  }

  async deletePolicy(id: string): Promise<boolean> {
    const existing = await this.findPolicyById(id);
    if (!existing) return false;
    this.db.run(sql`DELETE FROM notification_policies WHERE id = ${id}`);
    return true;
  }
}

/**
 * Back-compat alias — existing consumers (factory.ts, barrel) import
 * `SqliteAlertRuleRepository`. Keep the name exported so the parent's
 * factory reconciliation in a follow-up commit doesn't crash the build
 * before it lands.
 */
export const SqliteAlertRuleRepository = AlertRuleRepository;
export type SqliteAlertRuleRepository = AlertRuleRepository;
