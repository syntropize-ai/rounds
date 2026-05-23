import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';
import {
  getConnectorTemplate,
  type ConnectorCredentialKind,
  type ConnectorType,
} from '@agentic-obs/common';
import {
  ConnectorConfigFields,
  configIsValid,
  defaultsFor,
} from '../../pages/connector-config-form.js';
import { buildSecretValue } from '../../pages/Settings.js';
import type { ConnectorRow } from './types.js';
import { inputCls, btnPrimary, btnSecondary } from './styles.js';

interface CredentialsSectionProps {
  kind: ConnectorCredentialKind;
  secret: string;
  onSecretChange: (next: string) => void;
  basicUsername: string;
  onBasicUsernameChange: (next: string) => void;
  basicPassword: string;
  onBasicPasswordChange: (next: string) => void;
}

function CredentialsSection({
  kind,
  secret,
  onSecretChange,
  basicUsername,
  onBasicUsernameChange,
  basicPassword,
  onBasicPasswordChange,
}: CredentialsSectionProps): React.ReactElement | null {
  if (kind === 'none') return null;
  const hintCls = 'text-xs text-[var(--color-on-surface-variant)] mt-1.5';
  const headingCls = 'text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]';
  const labelCls = 'block text-sm font-medium text-[var(--color-on-surface)] mb-1.5';
  return (
    <div data-testid="credentials-section" className="space-y-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
      <p className={headingCls}>Credentials</p>
      {kind === 'token' && (
        <div>
          <label className={labelCls}>Bearer token (leave blank to keep existing)</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            placeholder="Paste token — stored encrypted"
            className={inputCls}
            data-testid="credential-token"
          />
          <p className={hintCls}>Required for authenticated endpoints; leave blank to keep the existing secret.</p>
        </div>
      )}
      {kind === 'kubeconfig' && (
        <div>
          <label className={labelCls}>Kubeconfig YAML (leave blank to keep existing)</label>
          <textarea
            rows={6}
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            placeholder="Paste kubeconfig contents"
            className={inputCls + ' font-mono'}
            data-testid="credential-kubeconfig"
          />
          <p className={hintCls}>
            Required when rounds runs outside the cluster. Leave blank when rounds runs in-cluster — the mounted service account is used automatically.
          </p>
        </div>
      )}
      {(kind as string) === 'basic' && (
        <div className="space-y-2">
          <div>
            <label className={labelCls}>Username</label>
            <input
              type="text"
              value={basicUsername}
              onChange={(e) => onBasicUsernameChange(e.target.value)}
              className={inputCls}
              data-testid="credential-basic-username"
            />
          </div>
          <div>
            <label className={labelCls}>Password</label>
            <input
              type="password"
              value={basicPassword}
              onChange={(e) => onBasicPasswordChange(e.target.value)}
              className={inputCls}
              data-testid="credential-basic-password"
            />
          </div>
          <p className={hintCls}>Stored encrypted as JSON &#123;username, password&#125;.</p>
        </div>
      )}
      {kind !== 'token' && kind !== 'kubeconfig' && (kind as string) !== 'basic' && (
        <div>
          <label className={labelCls}>Credential (leave blank to keep existing)</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            className={inputCls}
            data-testid="credential-generic"
          />
        </div>
      )}
    </div>
  );
}

export interface ConnectorConfigSectionProps {
  connector: ConnectorRow;
  canWrite: boolean;
  onSaved: () => void;
}

/**
 * Config form for an existing connector. Renders the schema-driven config
 * fields, credential rotation inputs, and Save / Test controls.
 * GitHub connectors get their own panel (see ConnectorDetail) — this one
 * assumes a paste-credential flow. Delete is rendered by ConnectorDetail's
 * header.
 */
export function ConnectorConfigSection({
  connector,
  canWrite,
  onSaved,
}: ConnectorConfigSectionProps): React.ReactElement {
  const type = connector.type as ConnectorType;
  const credentialKind = getConnectorTemplate(type).credential;

  const [name, setName] = useState(connector.name);
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({
    ...defaultsFor(type),
    ...(connector.config ?? {}),
  }));
  const [isDefault, setIsDefault] = useState(!!connector.isDefault);
  const [secret, setSecret] = useState('');
  const [basicUsername, setBasicUsername] = useState('');
  const [basicPassword, setBasicPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);

  // Re-sync local state when the selected connector changes from outside.
  useEffect(() => {
    setName(connector.name);
    setConfig({ ...defaultsFor(type), ...(connector.config ?? {}) });
    setIsDefault(!!connector.isDefault);
    setSecret('');
    setBasicUsername('');
    setBasicPassword('');
    setError(null);
    setSaved(false);
    setTestResult(null);
  }, [connector.id, connector.name, connector.config, connector.isDefault, type]);

  useEffect(() => {
    if (!testResult) return;
    const t = setTimeout(() => setTestResult(null), 8000);
    return () => clearTimeout(t);
  }, [testResult]);

  const basicIncomplete =
    (credentialKind as string) === 'basic' &&
    (!!basicUsername.trim() !== !!basicPassword);
  const submitEnabled =
    !submitting && !!name && configIsValid(type, config) && !basicIncomplete;

  const handleSave = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    const patchRes = await apiClient.put<{ connector: { id: string } }>(
      `/connectors/${connector.id}`,
      { name, config, isDefault },
    );
    if (patchRes.error) {
      setSubmitting(false);
      setError(patchRes.error.message ?? 'Failed to update connector');
      return;
    }
    const built = buildSecretValue(credentialKind, secret, basicUsername, basicPassword);
    if (built.kind === 'error') {
      setSubmitting(false);
      setError(built.message);
      return;
    }
    if (built.kind === 'send') {
      const secretRes = await apiClient.post(`/connectors/${connector.id}/secret`, {
        secret: built.value,
      });
      if (secretRes.error) {
        setSubmitting(false);
        setError(`Saved, but credential rotation failed: ${secretRes.error.message ?? 'unknown error'}`);
        onSaved();
        return;
      }
    }
    setSubmitting(false);
    setSaved(true);
    setSecret('');
    setBasicUsername('');
    setBasicPassword('');
    setTimeout(() => setSaved(false), 2000);
    onSaved();
  }, [basicPassword, basicUsername, config, connector.id, credentialKind, isDefault, name, onSaved, secret]);

  const handleTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiClient.post<{ ok: boolean; message?: string; detail?: string }>(
        `/connectors/${connector.id}/test`,
        {},
      );
      if (res.error) {
        setTestResult({ ok: false, message: res.error.message ?? 'Test failed' });
      } else {
        setTestResult({
          ok: !!res.data?.ok,
          ...(res.data?.message
            ? { message: res.data.message }
            : res.data?.detail
              ? { message: res.data.detail }
              : {}),
        });
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }, [connector.id, testing]);

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-[var(--color-on-surface)]">Configuration</h3>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error" role="alert">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputCls}
          disabled={!canWrite}
        />
      </div>

      <ConnectorConfigFields type={type} config={config} onChange={setConfig} />

      <CredentialsSection
        kind={credentialKind}
        secret={secret}
        onSecretChange={setSecret}
        basicUsername={basicUsername}
        onBasicUsernameChange={setBasicUsername}
        basicPassword={basicPassword}
        onBasicPasswordChange={setBasicPassword}
      />

      <label className="flex items-center gap-2 text-sm text-[var(--color-on-surface)]">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          disabled={!canWrite}
        />
        Set as default for this type
      </label>

      <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-[var(--color-outline-variant)]/30">
        <button
          type="button"
          className={btnSecondary}
          disabled={!canWrite || testing}
          onClick={() => void handleTest()}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        {testResult && (
          <span
            className={`rounded px-2 py-1 text-[11px] ${
              testResult.ok ? 'bg-secondary/10 text-secondary' : 'bg-error/10 text-error'
            }`}
            title={testResult.message ?? ''}
          >
            {testResult.ok ? 'OK' : testResult.message ? `Cannot connect: ${testResult.message}` : 'Test failed'}
          </span>
        )}
        <div className="flex-1" />
        {canWrite && (
          <button
            type="button"
            className={btnPrimary}
            disabled={!submitEnabled}
            onClick={() => void handleSave()}
          >
            {submitting ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>
        )}
      </div>
    </section>
  );
}

export default ConnectorConfigSection;
