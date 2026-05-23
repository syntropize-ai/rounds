import React, { useState } from 'react';
import {
  getConnectorTemplate,
  type ConnectorType,
} from '@agentic-obs/common';
import { apiClient } from '../../api/client.js';
import {
  ConnectorConfigFields,
  configIsValid,
  defaultsFor,
  reconcileConfig,
} from '../../pages/connector-config-form.js';
import { submitConnectorWithSecret } from '../../pages/Settings.js';
import GithubConnectorPanel from './GithubConnectorPanel.js';
import { inputCls, selectCls, btnPrimary, btnSecondary } from './styles.js';

const CONNECTOR_TYPES: ConnectorType[] = [
  'prometheus',
  'victoria-metrics',
  'loki',
  'elasticsearch',
  'clickhouse',
  'tempo',
  'jaeger',
  'otel',
  'kubernetes',
  'github',
];

export interface AddConnectorPanelProps {
  canWrite: boolean;
  onCreated: (connectorId: string) => void;
  onCancel: () => void;
}

export function AddConnectorPanel({
  canWrite,
  onCreated,
  onCancel,
}: AddConnectorPanelProps): React.ReactElement {
  const [type, setType] = useState<ConnectorType>('prometheus');
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>(() => defaultsFor('prometheus'));
  const [isDefault, setIsDefault] = useState(false);
  const [secret, setSecret] = useState('');
  const [basicUsername, setBasicUsername] = useState('');
  const [basicPassword, setBasicPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const credentialKind = getConnectorTemplate(type).credential;
  const basicIncomplete =
    (credentialKind as string) === 'basic' &&
    (!!basicUsername.trim() !== !!basicPassword);
  const submitEnabled =
    !submitting && !!name && configIsValid(type, config) && !basicIncomplete;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await submitConnectorWithSecret(apiClient, {
      type,
      name,
      config,
      isDefault,
      id,
      credential: credentialKind,
      secret,
      basicUsername,
      basicPassword,
    });
    setSubmitting(false);
    if (result.kind === 'validation-error' || result.kind === 'create-failed') {
      setError(result.message);
      return;
    }
    if (result.kind === 'secret-failed') {
      setError(`Connector created but secret upload failed: ${result.message}. Retry via Edit.`);
      onCreated(result.connectorId);
      return;
    }
    onCreated(result.connectorId);
  };

  if (type === 'github') {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-[var(--color-outline-variant)]/30 px-6 py-4">
          <h2 className="text-base font-semibold text-[var(--color-on-surface)]">New connector</h2>
          <p className="mt-1 text-xs text-[var(--color-on-surface-variant)]">
            Pick a type, fill in the config, then create.
          </p>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Type</label>
            <select
              value={type}
              onChange={(e) => {
                const next = e.target.value as ConnectorType;
                setConfig((prev) => reconcileConfig(prev, next));
                setType(next);
                setSecret('');
                setBasicUsername('');
                setBasicPassword('');
              }}
              className={selectCls}
            >
              {CONNECTOR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <GithubConnectorPanel canWrite={canWrite} onChanged={() => onCreated('github')} />
          <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
            <button type="button" onClick={onCancel} className={btnSecondary}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--color-outline-variant)]/30 px-6 py-4">
        <h2 className="text-base font-semibold text-[var(--color-on-surface)]">New connector</h2>
        <p className="mt-1 text-xs text-[var(--color-on-surface-variant)]">
          Pick a type, fill in the config, then create.
        </p>
      </header>
      <form onSubmit={(e) => void handleCreate(e)} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {error && (
          <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error" role="alert">
            {error}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Type</label>
          <select
            value={type}
            onChange={(e) => {
              const next = e.target.value as ConnectorType;
              setConfig((prev) => reconcileConfig(prev, next));
              setType(next);
              setSecret('');
              setBasicUsername('');
              setBasicPassword('');
            }}
            className={selectCls}
          >
            {CONNECTOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Prod Prometheus"
            className={inputCls}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">ID (optional)</label>
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="auto-generated if blank"
            className={inputCls}
          />
        </div>
        <ConnectorConfigFields type={type} config={config} onChange={setConfig} />
        {credentialKind !== 'none' && (
          <div className="space-y-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">Credentials</p>
            {credentialKind === 'token' && (
              <div>
                <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Bearer token (optional)</label>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className={inputCls} />
              </div>
            )}
            {credentialKind === 'kubeconfig' && (
              <div>
                <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Kubeconfig YAML (optional)</label>
                <textarea rows={6} value={secret} onChange={(e) => setSecret(e.target.value)} className={inputCls + ' font-mono'} />
              </div>
            )}
            {(credentialKind as string) === 'basic' && (
              <div className="space-y-2">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Username</label>
                  <input type="text" value={basicUsername} onChange={(e) => setBasicUsername(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Password</label>
                  <input type="password" value={basicPassword} onChange={(e) => setBasicPassword(e.target.value)} className={inputCls} />
                </div>
              </div>
            )}
            {credentialKind !== 'token' && credentialKind !== 'kubeconfig' && (credentialKind as string) !== 'basic' && (
              <div>
                <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">Credential (optional)</label>
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className={inputCls} />
              </div>
            )}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-[var(--color-on-surface)]">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Set as default for this type
        </label>
        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-outline-variant)]/30">
          <button type="button" onClick={onCancel} className={btnSecondary} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary} disabled={!submitEnabled}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default AddConnectorPanel;
