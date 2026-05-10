/**
 * Connector-model configuration handlers.
 *
 * This is the hard-switch surface from optimize/connector-model-redesign.md.
 * The agent works with connectors through connector_* tools and with a small
 * allowlisted settings surface through setting_* tools.
 */

import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

const CREDENTIAL_KEYS = ['password', 'passwd', 'token', 'apikey', 'api_key', 'authorization', 'secret', 'credential', 'privatekey', 'private_key', 'kubeconfig'];

const SETTING_KEYS = new Set([
  'default_alert_folder_uid',
  'default_dashboard_folder_uid',
  'notification_default_channel',
  'auto_investigation_enabled',
]);

function rejectRawCredentials(args: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(args)) {
    const lc = key.toLowerCase();
    if (CREDENTIAL_KEYS.includes(lc) && value !== undefined && value !== null && value !== '') {
      return `Refusing to accept raw "${key}". Capture secrets through the connector secret endpoint, then reference the connector by id.`;
    }
  }
  const config = args.config;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      const lc = key.toLowerCase();
      if (CREDENTIAL_KEYS.includes(lc) && value !== undefined && value !== null && value !== '') {
        return `Refusing to accept raw config.${key}. Capture secrets through the connector secret endpoint, then reference the connector by id.`;
      }
    }
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function redactParamsForAudit(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const lc = key.toLowerCase();
    if (CREDENTIAL_KEYS.includes(lc)) {
      out[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactParamsForAudit(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function handleConnectorList(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const category = optionalString(args.category);
  const capability = optionalString(args.capability);
  const status = optionalString(args.status);

  return withToolEventBoundary(
    ctx.sendEvent,
    'connector_list',
    redactParamsForAudit({ category, capability, status }),
    'Listing connectors',
    async () => {
      if (!ctx.configService) return 'Connector listing is not available in this deployment. Use Settings → Connectors.';
      const connectors = await ctx.configService.listConnectors({
        orgId: ctx.identity.orgId,
        ...(category ? { category } : {}),
        ...(capability ? { capability } : {}),
        ...(status ? { status } : {}),
      });
      if (connectors.length === 0) return 'No connectors match that filter.';
      return JSON.stringify({ connectors });
    },
  );
}

export async function handleConnectorTemplateList(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const category = optionalString(args.category);
  const capability = optionalString(args.capability);

  return withToolEventBoundary(
    ctx.sendEvent,
    'connector_template_list',
    redactParamsForAudit({ category, capability }),
    'Listing connector templates',
    async () => {
      if (!ctx.configService) return 'Connector templates are not available in this deployment. Use Settings → Connectors.';
      const templates = await ctx.configService.listConnectorTemplates({
        ...(category ? { category } : {}),
        ...(capability ? { capability } : {}),
      });
      if (templates.length === 0) return 'No connector templates match that filter.';
      return JSON.stringify({ templates });
    },
  );
}

export async function handleConnectorDetect(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const template = optionalString(args.template);

  return withToolEventBoundary(
    ctx.sendEvent,
    'connector_detect',
    redactParamsForAudit({ template }),
    template ? `Detecting ${template} connectors` : 'Detecting connectors',
    async () => {
      if (!ctx.configService) return 'Connector detection is not available in this deployment. Use Settings → Connectors.';
      const candidates = await ctx.configService.detectConnectors({
        orgId: ctx.identity.orgId,
        ...(template ? { template } : {}),
      });
      if (candidates.length === 0) return 'No connector candidates detected.';
      return JSON.stringify({ candidates });
    },
  );
}

export async function handleConnectorPropose(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const template = optionalString(args.template) ?? '';
  const name = optionalString(args.name) ?? '';
  const config = asRecord(args.config);
  const scope = asRecord(args.scope);
  const isDefault = args.isDefault === true;

  return withToolEventBoundary(
    ctx.sendEvent,
    'connector_propose',
    redactParamsForAudit({ template, name, config, ...(scope ? { scope } : {}), ...(isDefault ? { isDefault } : {}) }),
    `Proposing connector "${name || template}"`,
    async () => {
      const credErr = rejectRawCredentials(args);
      if (credErr) return `Error: ${credErr}`;
      if (!ctx.configService) return 'Connector proposal is not available in this deployment. Use Settings → Connectors.';
      if (!template) return 'Error: "template" is required.';
      if (!name) return 'Error: "name" is required.';
      if (!config) return 'Error: "config" must be an object.';

      const draft = await ctx.configService.proposeConnector({
        orgId: ctx.identity.orgId,
        template,
        name,
        config,
        ...(scope ? { scope } : {}),
        ...(isDefault ? { isDefault } : {}),
        actorUserId: ctx.identity.userId ?? null,
      });

      const credentialLine = draft.needsCredential
        ? ' needsCredential=true. Capture the secret with POST /api/connectors/:id/secret after apply.'
        : ' needsCredential=false.';
      return `Proposed ${template} connector "${name}" (draftId: ${draft.draftId}).${credentialLine} Capabilities: ${draft.capabilityPreview.join(', ') || 'none'}.`;
    },
  );
}

export async function handleConnectorApply(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const draftId = optionalString(args.draftId) ?? '';

  return withToolEventBoundary(
    ctx.sendEvent,
    'connector_apply',
    redactParamsForAudit({ draftId }),
    `Applying connector draft ${draftId}`,
    async () => {
      if (!ctx.configService) return 'Connector apply is not available in this deployment. Use Settings → Connectors.';
      if (!draftId) return 'Error: "draftId" is required.';
      const applied = await ctx.configService.applyConnectorDraft({
        orgId: ctx.identity.orgId,
        draftId,
        actorUserId: ctx.identity.userId ?? null,
      });
      return `Applied connector draft ${draftId}. connectorId=${applied.connectorId}, status=${applied.status}, capabilities=${applied.capabilities.join(', ') || 'none'}.`;
    },
  );
}

export async function handleConnectorTest(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const connectorId = optionalString(args.connectorId) ?? '';

  return withToolEventBoundary(
    ctx.sendEvent,
    'connector_test',
    redactParamsForAudit({ connectorId }),
    `Testing connector ${connectorId}`,
    async () => {
      if (!ctx.configService) return 'Connector testing is not available in this deployment. Use Settings → Connectors.';
      if (!connectorId) return 'Error: "connectorId" is required.';
      const result = await ctx.configService.testConnector(connectorId, ctx.identity.orgId);
      return result.ok
        ? `Connector ${connectorId} test OK${typeof result.latencyMs === 'number' ? ` (${result.latencyMs}ms)` : ''}. Capabilities: ${result.capabilities.join(', ') || 'none'}.`
        : `Connector ${connectorId} test FAILED: ${result.error ?? 'unknown error'}.`;
    },
  );
}

export async function handleSettingGet(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const key = optionalString(args.key) ?? '';

  return withToolEventBoundary(
    ctx.sendEvent,
    'setting_get',
    redactParamsForAudit({ key }),
    `Reading setting "${key}"`,
    async () => {
      if (!ctx.configService) return 'Settings reads are not available in this deployment. Use Settings.';
      if (!key) return 'Error: "key" is required.';
      if (!SETTING_KEYS.has(key)) return `Error: "${key}" is not in the AI-readable settings allowlist. Allowed keys: ${[...SETTING_KEYS].join(', ')}.`;
      const value = await ctx.configService.getSetting(key, ctx.identity.orgId);
      return value === null ? `Setting "${key}" is not set.` : `Setting "${key}" is "${value}".`;
    },
  );
}

export async function handleSettingSet(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const key = optionalString(args.key) ?? '';
  const value = typeof args.value === 'string' ? args.value : '';

  return withToolEventBoundary(
    ctx.sendEvent,
    'setting_set',
    redactParamsForAudit({ key, value }),
    `Updating setting "${key}"`,
    async () => {
      const credErr = rejectRawCredentials(args);
      if (credErr) return `Error: ${credErr}`;
      if (!ctx.configService) return 'Settings writes are not available in this deployment. Use Settings.';
      if (!key) return 'Error: "key" is required.';
      if (!SETTING_KEYS.has(key)) return `Error: "${key}" is not in the AI-configurable settings allowlist. Allowed keys: ${[...SETTING_KEYS].join(', ')}.`;
      if (!value) return 'Error: "value" is required.';
      const previous = await ctx.configService.getSetting(key, ctx.identity.orgId);
      await ctx.configService.setSetting(key, value, {
        orgId: ctx.identity.orgId,
        userId: ctx.identity.userId ?? null,
      });
      return previous === null
        ? `Set "${key}" to "${value}".`
        : `Updated "${key}" from "${previous}" to "${value}".`;
    },
  );
}
