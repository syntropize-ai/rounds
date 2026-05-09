/**
 * Adapter that exposes `SetupConfigService` + `IOpsConnectorRepository` via
 * the narrow `AgentConfigService` surface used by the AI-first configuration
 * tools (Task 07).
 *
 * The agent layer stays decoupled from gateway internals; the adapter just
 * picks the methods the agent actually needs and converts shapes.
 *
 * Secret hygiene: the adapter does NOT accept raw credentials. The agent
 * passes an opaque `secretRef`. If a credential is required and `secretRef`
 * is missing the saved record will report `secretMissing: true` so the
 * handler can return a structured `needs_credential` response with a UI
 * deep link.
 */

import type { AgentConfigService } from '@agentic-obs/agent-core';
import type { DatasourceType, NewInstanceDatasource, InstanceDatasourcePatch } from '@agentic-obs/common';
import type {
  IOpsConnectorRepository,
  OpsConnector,
} from '@agentic-obs/data-layer';
import type { SetupConfigService } from './setup-config-service.js';
import { testDatasourceConnection } from '../utils/datasource.js';
import {
  type KubernetesConnectorRunner,
  LiveKubernetesConnectorRunner,
} from './ops-connector-service.js';

export interface AgentConfigAdapterDeps {
  setupConfig: SetupConfigService;
  opsConnectors: IOpsConnectorRepository;
  opsRunner?: KubernetesConnectorRunner;
}

export function createAgentConfigService(deps: AgentConfigAdapterDeps): AgentConfigService {
  const opsRunner = deps.opsRunner ?? new LiveKubernetesConnectorRunner();
  const datasourceTypesNeedingCreds = new Set<string>([
    // Datasource types that essentially always need credentials in production.
    // The handler uses this to surface needs_credential when secretRef is absent.
    'elasticsearch',
  ]);

  return {
    async upsertDatasource(input) {
      const orgId = input.orgId;
      // The agent never hands us raw credentials. We don't store secretRef
      // (instance_datasources doesn't have a column today) — it's only used
      // to surface the needs_credential signal back to the agent until the
      // user attaches credentials via Settings UI. Storing the reference can
      // be a follow-up.
      if (input.id) {
        const patch: InstanceDatasourcePatch = {
          type: input.type as DatasourceType,
          name: input.name,
          url: input.url,
          environment: input.environment ?? null,
          cluster: input.cluster ?? null,
          label: input.label ?? null,
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        };
        const updated = await deps.setupConfig.updateDatasource(input.id, patch, {
          userId: input.actorUserId ?? null,
          orgId,
        });
        if (!updated) throw new Error(`Datasource "${input.id}" not found in org ${orgId}`);
        return {
          id: updated.id,
          type: updated.type,
          name: updated.name,
          url: updated.url,
          ...(needsCreds(updated.type, !!input.secretRef) ? { secretMissing: true } : {}),
        };
      }
      const newRow: NewInstanceDatasource = {
        orgId,
        type: input.type as DatasourceType,
        name: input.name,
        url: input.url,
        environment: input.environment ?? null,
        cluster: input.cluster ?? null,
        label: input.label ?? null,
        isDefault: input.isDefault ?? false,
      };
      const created = await deps.setupConfig.createDatasource(newRow, {
        userId: input.actorUserId ?? null,
      });
      return {
        id: created.id,
        type: created.type,
        name: created.name,
        url: created.url,
        ...(needsCreds(created.type, !!input.secretRef) ? { secretMissing: true } : {}),
      };

      function needsCreds(type: string, hasSecretRef: boolean): boolean {
        if (hasSecretRef) return false;
        return datasourceTypesNeedingCreds.has(type);
      }
    },

    async testDatasource(id, orgId) {
      const ds = await deps.setupConfig.getDatasource(id, { orgId });
      if (!ds) return { ok: false, message: `Datasource "${id}" not found.` };
      return testDatasourceConnection({
        type: ds.type,
        url: ds.url,
        apiKey: ds.apiKey ?? undefined,
        username: ds.username ?? undefined,
        password: ds.password ?? undefined,
      });
    },

    async upsertOpsConnector(input) {
      const orgId = input.orgId;
      if (input.id) {
        const updated = await deps.opsConnectors.update(orgId, input.id, {
          name: input.name,
          environment: input.environment ?? null,
          ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
          ...(input.allowedNamespaces ? { allowedNamespaces: input.allowedNamespaces } : {}),
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        });
        if (!updated) throw new Error(`Ops connector "${input.id}" not found in org ${orgId}`);
        return shapeOps(updated, input.secretRef);
      }
      const created = await deps.opsConnectors.create({
        orgId,
        type: 'kubernetes',
        name: input.name,
        environment: input.environment ?? null,
        secretRef: input.secretRef ?? null,
        secret: null,
        allowedNamespaces: input.allowedNamespaces ?? [],
        capabilities: input.capabilities ?? [],
      });
      return shapeOps(created, input.secretRef);
    },

    async testOpsConnector(id, orgId) {
      const connector = await deps.opsConnectors.findByIdInOrg(orgId, id);
      if (!connector) return { ok: false, message: `Ops connector "${id}" not found.` };
      const result = await opsRunner.test(connector);
      return {
        ok: result.status === 'connected',
        message: result.message ?? result.status,
        status: result.status,
      };
    },

    async getInstanceSetting(key) {
      // SetupConfigService doesn't expose getSetting directly; we read via
      // bootstrappedAt/configuredAt for the known keys, otherwise via the
      // underlying repo. For the AI-first allowlist we only need free-form
      // reads, so go through a small escape hatch on the service.
      const repo = (deps.setupConfig as unknown as { deps: { instanceConfig: { getSetting(k: string): Promise<string | null> } } }).deps?.instanceConfig;
      if (!repo) return null;
      return repo.getSetting(key);
    },

    async setInstanceSetting(key, value, _actor) {
      const repo = (deps.setupConfig as unknown as { deps: { instanceConfig: { setSetting(k: string, v: string): Promise<void> } } }).deps?.instanceConfig;
      if (!repo) throw new Error('instance settings repository unavailable');
      await repo.setSetting(key, value);
    },
  };
}

function shapeOps(
  c: OpsConnector,
  hadSecretRef: string | null | undefined,
): { id: string; name: string; type: string; secretMissing?: boolean } {
  const hasCreds = !!c.secret || !!c.secretRef || !!hadSecretRef;
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    ...(hasCreds ? {} : { secretMissing: true }),
  };
}
