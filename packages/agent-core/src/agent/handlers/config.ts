/**
 * AI-first configuration handlers — Task 07.
 *
 * Three tools let the user configure datasources, ops connectors, and
 * low-risk org settings by conversation:
 *
 *   - datasource_configure       (medium risk — user_confirm)
 *   - ops_connector_configure    (medium risk — user_confirm)
 *   - system_setting_configure   (low risk — none / direct write)
 *
 * Manual Settings UI keeps working unchanged. These handlers call the same
 * `AgentConfigService` surface that the Settings routes call so the two
 * paths stay aligned.
 *
 * Credentials hygiene
 * -------------------
 * Raw `password` / `token` / `apiKey` values NEVER enter this layer:
 *   - Tool input schemas don't expose those keys (only opaque `secretRef`).
 *   - The handler additionally rejects them at runtime if the model
 *     somehow smuggles them through (defense-in-depth).
 *   - SSE event payloads are run through `redactParamsForAudit` so audit
 *     captures structure but no secret values.
 *   - When a credential is required and missing, the handler returns a
 *     structured `needs_credential` outcome with a UI deep link instead of
 *     persisting a half-configured record with empty creds.
 */

import { redactParamsForAudit } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

const CREDENTIAL_KEYS = ['password', 'passwd', 'token', 'apikey', 'api_key', 'authorization', 'secret', 'credential', 'privatekey', 'private_key'];

/** Reject raw credentials sneaking through the tool input. */
function rejectRawCredentials(args: Record<string, unknown>): string | null {
  for (const k of Object.keys(args)) {
    const lc = k.toLowerCase();
    if (CREDENTIAL_KEYS.includes(lc)) {
      return `Refusing to accept raw "${k}". Pass an opaque secretRef created in Settings → Secrets and reference it by id.`;
    }
  }
  return null;
}

const VALID_DATASOURCE_TYPES = new Set(['prometheus', 'victoria-metrics', 'loki', 'elasticsearch', 'clickhouse', 'tempo', 'jaeger', 'otel']);

const LOW_RISK_SETTING_KEYS = new Set([
  'default_alert_folder_uid',
  'default_dashboard_folder_uid',
]);

// ---------------------------------------------------------------------------
// datasource_configure
// ---------------------------------------------------------------------------

export async function handleDatasourceConfigure(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : undefined;
  const type = typeof args.type === 'string' ? args.type.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  const secretRef = typeof args.secretRef === 'string' && args.secretRef.trim() !== ''
    ? args.secretRef.trim()
    : null;
  const isDefault = args.isDefault === true;
  const test = args.test !== false; // default true

  // Sanitized arg snapshot for SSE — no raw creds even if present.
  const sanitizedArgs = redactParamsForAudit({
    ...(id ? { id } : {}),
    type, name, url,
    ...(secretRef ? { secretRef } : {}),
    ...(isDefault ? { isDefault } : {}),
    test,
  });

  return withToolEventBoundary(
    ctx.sendEvent,
    'datasource_configure',
    sanitizedArgs,
    id ? `Updating datasource ${id}` : `Creating datasource "${name || type}"`,
    async () => {
      const credErr = rejectRawCredentials(args);
      if (credErr) return `Error: ${credErr}`;

      if (!ctx.configService) {
        return 'Datasource configuration is not available in this deployment. Use Settings → Datasources.';
      }
      if (!type) return 'Error: "type" is required.';
      if (!VALID_DATASOURCE_TYPES.has(type)) {
        return `Error: unknown datasource type "${type}". Supported: ${[...VALID_DATASOURCE_TYPES].join(', ')}.`;
      }
      if (!name) return 'Error: "name" is required.';
      if (!url) return 'Error: "url" is required.';

      const saved = await ctx.configService.upsertDatasource({
        ...(id ? { id } : {}),
        orgId: ctx.identity.orgId,
        type,
        name,
        url,
        ...(secretRef ? { secretRef } : {}),
        ...(isDefault ? { isDefault } : {}),
        actorUserId: ctx.identity.userId ?? null,
      });

      // If the datasource type usually needs a credential and none was
      // supplied (and the saved record reports it missing), surface a
      // structured needs_credential outcome with a UI deep link.
      if (saved.secretMissing) {
        const link = `/settings/datasources/${saved.id}`;
        return `needs_credential: datasource "${saved.name}" was saved but requires credentials. Open ${link} to attach a secret. Until then connection tests will fail.`;
      }

      let testLine = '';
      if (test) {
        try {
          const probe = await ctx.configService.testDatasource(saved.id, ctx.identity.orgId);
          testLine = probe.ok
            ? ` Connection test OK: ${probe.message}.`
            : ` Connection test FAILED: ${probe.message}.`;
        } catch (err) {
          testLine = ` Connection test failed: ${err instanceof Error ? err.message : String(err)}.`;
        }
      }

      const verb = id ? 'Updated' : 'Created';
      return `${verb} ${type} datasource "${saved.name}" (id: ${saved.id}, url: ${saved.url}).${testLine}`;
    },
  );
}

// ---------------------------------------------------------------------------
// ops_connector_configure
// ---------------------------------------------------------------------------

export async function handleOpsConnectorConfigure(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : undefined;
  const type = typeof args.type === 'string' ? args.type.trim() : 'kubernetes';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const environment = typeof args.environment === 'string' ? args.environment.trim() : null;
  const secretRef = typeof args.secretRef === 'string' && args.secretRef.trim() !== ''
    ? args.secretRef.trim()
    : null;
  const allowedNamespaces = Array.isArray(args.allowedNamespaces)
    ? (args.allowedNamespaces as unknown[]).filter((n): n is string => typeof n === 'string')
    : undefined;
  const capabilities = Array.isArray(args.capabilities)
    ? (args.capabilities as unknown[]).filter((n): n is string => typeof n === 'string')
    : undefined;
  const test = args.test !== false;

  const sanitizedArgs = redactParamsForAudit({
    ...(id ? { id } : {}),
    type, name,
    ...(environment ? { environment } : {}),
    ...(secretRef ? { secretRef } : {}),
    ...(allowedNamespaces ? { allowedNamespaces } : {}),
    ...(capabilities ? { capabilities } : {}),
    test,
  });

  return withToolEventBoundary(
    ctx.sendEvent,
    'ops_connector_configure',
    sanitizedArgs,
    id ? `Updating ops connector ${id}` : `Creating ops connector "${name || 'kubernetes'}"`,
    async () => {
      const credErr = rejectRawCredentials(args);
      if (credErr) return `Error: ${credErr}`;

      if (!ctx.configService) {
        return 'Ops connector configuration is not available in this deployment. Use Settings → Ops Connectors.';
      }
      if (type !== 'kubernetes') {
        return `Error: unsupported connector type "${type}". Only "kubernetes" is supported today.`;
      }
      if (!name) return 'Error: "name" is required.';

      const saved = await ctx.configService.upsertOpsConnector({
        ...(id ? { id } : {}),
        orgId: ctx.identity.orgId,
        type: 'kubernetes',
        name,
        environment,
        ...(secretRef ? { secretRef } : {}),
        ...(allowedNamespaces ? { allowedNamespaces } : {}),
        ...(capabilities ? { capabilities } : {}),
        actorUserId: ctx.identity.userId ?? null,
      });

      if (saved.secretMissing) {
        const link = `/settings/ops-connectors/${saved.id}`;
        return `needs_credential: ops connector "${saved.name}" was saved but requires kubeconfig credentials. Open ${link} to attach a kubeconfig or in-cluster service account.`;
      }

      let testLine = '';
      if (test) {
        try {
          const probe = await ctx.configService.testOpsConnector(saved.id, ctx.identity.orgId);
          testLine = probe.ok
            ? ` Connection test OK: ${probe.message}.`
            : ` Connection test FAILED: ${probe.message}${probe.status ? ` (status: ${probe.status})` : ''}.`;
        } catch (err) {
          testLine = ` Connection test failed: ${err instanceof Error ? err.message : String(err)}.`;
        }
      }

      const verb = id ? 'Updated' : 'Created';
      return `${verb} ${saved.type} ops connector "${saved.name}" (id: ${saved.id}).${testLine}`;
    },
  );
}

// ---------------------------------------------------------------------------
// system_setting_configure
// ---------------------------------------------------------------------------

export async function handleSystemSettingConfigure(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  const value = typeof args.value === 'string' ? args.value : '';

  return withToolEventBoundary(
    ctx.sendEvent,
    'system_setting_configure',
    redactParamsForAudit({ key, value }),
    `Updating org setting "${key}"`,
    async () => {
      const credErr = rejectRawCredentials(args);
      if (credErr) return `Error: ${credErr}`;

      if (!ctx.configService) {
        return 'Settings configuration is not available in this deployment. Use Settings → General.';
      }
      if (!key) return 'Error: "key" is required.';
      if (!LOW_RISK_SETTING_KEYS.has(key)) {
        return `Error: "${key}" is not in the AI-configurable allowlist. ` +
          `Permission, role, and credential changes must go through Settings UI directly. ` +
          `Allowed keys: ${[...LOW_RISK_SETTING_KEYS].join(', ')}.`;
      }
      if (!value) return 'Error: "value" is required.';

      const previous = await ctx.configService.getInstanceSetting(key);
      await ctx.configService.setInstanceSetting(key, value, {
        userId: ctx.identity.userId ?? null,
      });
      return previous === null
        ? `Set "${key}" to "${value}".`
        : `Updated "${key}" from "${previous}" to "${value}".`;
    },
  );
}
