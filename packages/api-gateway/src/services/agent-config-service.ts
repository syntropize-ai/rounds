/**
 * The implementation `AgentConfigService` has been waiting for.
 *
 * `packages/agent-core/src/agent/types.ts` declares this surface and the
 * `connector_*` / `setting_*` handlers in `agent-core/src/agent/handlers/
 * config.ts` are written against it, but nothing ever constructed one — so
 * every one of those tools answered "not available in this deployment" in
 * every deployment, and README's "Configure by chat" bullet described a
 * capability the build did not ship.
 *
 * This is deliberately a thin adapter. Connector reads and writes go through
 * the same `ConnectorService` the HTTP routes use, so the agent cannot reach
 * a path the API does not already expose, and templates come from the shared
 * registry rather than a second list that would drift.
 *
 * Two invariants hold the security line:
 *
 *   - Raw credentials never pass through here. `proposeConnector` takes
 *     config only; a connector that needs a secret is created without one and
 *     reports `needsCredential`, leaving capture to the existing
 *     `POST /api/connectors/:id/secret` endpoint. `handleConnectorPropose`
 *     already rejects credential-shaped arguments before we are called, and
 *     this class does not accept them either.
 *   - Nothing is written until `applyConnectorDraft`. A proposal parks in
 *     memory so the model can describe what it is about to do and the user
 *     can say no. Drafts are per-org, expire, and are lost on restart —
 *     losing one costs a re-proposal, never a half-created connector.
 *
 * RBAC is not re-implemented here: `tool-permissions.ts` already gates
 * `connector_propose` / `connector_apply` behind `connectors:write` and
 * `setting_set` behind instance-config write, and the permission gate runs
 * before the handler.
 */

import { randomUUID } from 'node:crypto';
import {
  CONNECTOR_TEMPLATES,
  getConnectorTemplate,
  type ConnectorTemplate,
  type ConnectorType,
} from '@agentic-obs/common';
import type {
  AgentConfigService,
  AgentConnectorCandidate,
  AgentConnectorSummary,
  AgentConnectorTemplateSummary,
} from '@agentic-obs/agent-core';
import type { ConnectorService } from './connector-service.js';

/** How long a proposal stays applicable. Long enough to talk it over, short
 *  enough that a forgotten draft cannot be applied later by surprise. */
const DRAFT_TTL_MS = 30 * 60 * 1000;

/** Detection runs inside a chat turn, so a dead address must not stall it. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Settings the agent may write. Everything absent from this list is
 * read-only to the agent even for an operator who could change it in the UI:
 * a chat turn is a weaker intent signal than a settings form, so the blast
 * radius stays small on purpose. Grow this deliberately.
 */
const AGENT_WRITABLE_SETTINGS: ReadonlySet<string> = new Set([
  'investigation.default_time_range',
  'dashboard.default_refresh_interval',
  'alerts.default_evaluation_interval',
]);

interface ConnectorDraft {
  orgId: string;
  template: ConnectorType;
  name: string;
  config: Record<string, unknown>;
  scope: Record<string, unknown> | null;
  isDefault: boolean;
  needsCredential: boolean;
  capabilityPreview: string[];
  expiresAt: number;
}

export interface AgentConfigServiceDeps {
  connectors: ConnectorService;
  /** Instance settings store. Omit to make every setting tool report that
   *  settings are unavailable rather than silently no-op. */
  settings?: {
    getSetting(key: string): Promise<string | null>;
    setSetting(key: string, value: string): Promise<void>;
  };
  /** Audit sink shared with the HTTP routes, so a connector created by chat
   *  is indistinguishable in the log from one created in the UI. */
  audit?: (entry: {
    action: string;
    actorId: string | null;
    orgId: string;
    targetType: string;
    targetId: string;
    outcome: 'success' | 'failure';
    metadata?: Record<string, unknown>;
  }) => void | Promise<void>;
}

export class AgentConfigServiceImpl implements AgentConfigService {
  private readonly drafts = new Map<string, ConnectorDraft>();

  constructor(private readonly deps: AgentConfigServiceDeps) {}

  async listConnectors(filter: {
    orgId: string;
    category?: string;
    capability?: string;
    status?: string;
  }): Promise<AgentConnectorSummary[]> {
    const connectors = await this.deps.connectors.list({ orgId: filter.orgId });
    return connectors
      .map((c) => {
        const template = safeTemplate(c.type);
        const capabilities = [...(template?.capabilities ?? [])];
        return {
          id: c.id,
          type: c.type,
          name: c.name,
          ...(template ? { category: [...template.category] } : {}),
          capabilities,
          status: c.status ?? 'unknown',
        } satisfies AgentConnectorSummary;
      })
      .filter((c) => {
        if (filter.status && c.status !== filter.status) return false;
        if (filter.category && !(c.category ?? []).some((cat) => cat === filter.category)) return false;
        if (filter.capability && !c.capabilities.includes(filter.capability)) return false;
        return true;
      });
  }

  listConnectorTemplates(filter: {
    category?: string;
    capability?: string;
  }): Promise<AgentConnectorTemplateSummary[]> {
    const summaries = CONNECTOR_TEMPLATES.filter((t) => {
      if (filter.category && !t.category.includes(filter.category as ConnectorTemplate['category'][number])) {
        return false;
      }
      if (filter.capability && !t.capabilities.includes(filter.capability)) return false;
      return true;
    }).map((t) => ({
      type: t.type,
      category: [...t.category],
      capabilities: [...t.capabilities],
      requiredFields: [...(t.configSchema.required ?? [])],
      credentialRequired: t.credential !== 'none',
    } satisfies AgentConnectorTemplateSummary));
    return Promise.resolve(summaries);
  }

  /**
   * Probes the well-known in-cluster addresses each template carries and
   * reports the ones that answer.
   *
   * Deliberately not a Kubernetes API scan: the chart grants the api-gateway
   * ServiceAccount no cluster read at all (`kubectl auth can-i list services`
   * is `no` on a default install), so listing services would mean widening
   * RBAC for a long-lived HTTP process. An HTTP GET to
   * `http://prometheus.monitoring.svc:9090` needs no permission beyond being
   * on the network, and a backend that answers its own verify path is far
   * better evidence than a service whose name merely looks right.
   *
   * A candidate is only reported after it responds — nothing here is a guess
   * the user has to disprove.
   */
  async detectConnectors(input: { orgId: string; template?: string }): Promise<AgentConnectorCandidate[]> {
    const templates = input.template
      ? [safeTemplate(input.template)].filter((t): t is ConnectorTemplate => t !== null)
      : CONNECTOR_TEMPLATES;

    const probes = templates.flatMap((template) => {
      if (template.detect?.kind !== 'k8s-service-probe') return [];
      const verifyPath = template.verify.kind === 'http-get' ? template.verify.path : '/';
      return template.detect.candidates.map(async (base): Promise<AgentConnectorCandidate | null> => {
        const reachable = await probe(`${base.replace(/\/$/, '')}${verifyPath}`);
        if (!reachable) return null;
        return {
          template: template.type,
          candidate: { url: base },
          confidence: 0.9,
          source: 'in-cluster probe',
        };
      });
    });

    const results = await Promise.all(probes);
    return results.filter((c): c is AgentConnectorCandidate => c !== null);
  }

  async proposeConnector(input: {
    orgId: string;
    template: string;
    name: string;
    config: Record<string, unknown>;
    scope?: Record<string, unknown> | null;
    isDefault?: boolean;
    actorUserId?: string | null;
  }): Promise<{ draftId: string; needsCredential: boolean; capabilityPreview: string[] }> {
    const template = safeTemplate(input.template);
    if (!template) {
      throw new Error(
        `Unknown connector template "${input.template}". Known templates: ${CONNECTOR_TEMPLATES.map((t) => t.type).join(', ')}.`,
      );
    }

    const missing = (template.configSchema.required ?? []).filter(
      (field) => input.config[field] === undefined || input.config[field] === '',
    );
    if (missing.length > 0) {
      throw new Error(`Missing required config for ${template.type}: ${missing.join(', ')}.`);
    }

    this.pruneExpiredDrafts();
    const draftId = randomUUID();
    this.drafts.set(draftId, {
      orgId: input.orgId,
      template: template.type,
      name: input.name,
      config: input.config,
      scope: input.scope ?? null,
      isDefault: input.isDefault === true,
      needsCredential: template.credential !== 'none',
      capabilityPreview: [...template.capabilities],
      expiresAt: Date.now() + DRAFT_TTL_MS,
    });

    return {
      draftId,
      needsCredential: template.credential !== 'none',
      capabilityPreview: [...template.capabilities],
    };
  }

  async applyConnectorDraft(input: {
    orgId: string;
    draftId: string;
    actorUserId?: string | null;
  }): Promise<{ connectorId: string; status: string; capabilities: string[] }> {
    this.pruneExpiredDrafts();
    const draft = this.drafts.get(input.draftId);
    if (!draft) {
      throw new Error(`No draft ${input.draftId} — it expired or was already applied. Propose the connector again.`);
    }
    // A draft carries the org it was proposed under; applying it from another
    // org would let a cross-org chat turn create a connector out of thin air.
    if (draft.orgId !== input.orgId) {
      throw new Error(`No draft ${input.draftId} — it expired or was already applied. Propose the connector again.`);
    }

    const connector = await this.deps.connectors.create({
      orgId: input.orgId,
      type: draft.template,
      name: draft.name,
      config: draft.config,
      // Attribute the row to the person whose chat turn asked for it, so a
      // connector created here is traceable the same way one created in the UI is.
      createdBy: input.actorUserId ?? 'agent',
      ...(draft.isDefault ? { isDefault: true } : {}),
      ...(draft.scope ? { scope: draft.scope } : {}),
    } as Parameters<ConnectorService['create']>[0]);

    // Single-use: a draft that has become a connector must not be applicable
    // again, or a retry would create a duplicate.
    this.drafts.delete(input.draftId);

    await this.deps.audit?.({
      action: 'connector.create',
      actorId: input.actorUserId ?? null,
      orgId: input.orgId,
      targetType: 'connector',
      targetId: connector.id,
      outcome: 'success',
      metadata: { via: 'agent_tool', template: draft.template, needsCredential: draft.needsCredential },
    });

    return {
      connectorId: connector.id,
      status: connector.status ?? 'unknown',
      capabilities: draft.capabilityPreview,
    };
  }

  async testConnector(
    connectorId: string,
    orgId: string,
  ): Promise<{ ok: boolean; latencyMs?: number; capabilities: string[]; error?: string }> {
    const startedAt = Date.now();
    const result = await this.deps.connectors.test(orgId, connectorId);
    if (!result) {
      return { ok: false, capabilities: [], error: `No connector ${connectorId} in this organisation.` };
    }
    return {
      ok: result.ok,
      latencyMs: Date.now() - startedAt,
      capabilities: [...(result.capabilities ?? [])],
      ...(result.ok ? {} : { error: result.error ?? "Connection failed" }),
    };
  }

  async getSetting(key: string, _orgId: string): Promise<string | null> {
    if (!this.deps.settings) throw new Error('Settings are not available in this deployment.');
    return this.deps.settings.getSetting(key);
  }

  async setSetting(
    key: string,
    value: string,
    actor: { orgId: string; userId: string | null },
  ): Promise<void> {
    if (!this.deps.settings) throw new Error('Settings are not available in this deployment.');
    if (!AGENT_WRITABLE_SETTINGS.has(key)) {
      throw new Error(
        `"${key}" cannot be changed from chat. Agent-writable settings: ${[...AGENT_WRITABLE_SETTINGS].join(', ')}.`,
      );
    }
    await this.deps.settings.setSetting(key, value);
    await this.deps.audit?.({
      action: 'settings.update',
      actorId: actor.userId,
      orgId: actor.orgId,
      targetType: 'setting',
      targetId: key,
      outcome: 'success',
      metadata: { via: 'agent_tool' },
    });
  }

  private pruneExpiredDrafts(): void {
    const now = Date.now();
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt <= now) this.drafts.delete(id);
    }
  }
}

function safeTemplate(type: string): ConnectorTemplate | null {
  try {
    return getConnectorTemplate(type as ConnectorType) ?? null;
  } catch {
    return null;
  }
}

/**
 * A short, failure-tolerant reachability check. Any answer at all — including
 * 401/403 — means something is listening and speaking HTTP there, which is
 * what "detected" claims; only the URL is reported, never a response body.
 */
async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.status < 500;
  } catch {
    return false;
  }
}
