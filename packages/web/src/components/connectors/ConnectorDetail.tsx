import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';
import type { ConnectorRow } from './types.js';
import ConnectorConfigSection from './ConnectorConfigSection.js';
import GithubConnectorPanel from './GithubConnectorPanel.js';
import PermissionsSection from './PermissionsSection.js';
import { btnSecondary } from './styles.js';

export interface ConnectorDetailProps {
  connector: ConnectorRow;
  canWrite: boolean;
  orgId: string;
  onSaved: () => void;
  onDeleted: () => void;
}

interface DeleteConnectorButtonProps {
  connector: ConnectorRow;
  canWrite: boolean;
  onDeleted: () => void;
  onError: (message: string) => void;
}

function DeleteConnectorButton({
  connector,
  canWrite,
  onDeleted,
  onError,
}: DeleteConnectorButtonProps): React.ReactElement {
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-arm clears after 4s.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  // Reset armed state when switching connectors.
  useEffect(() => {
    setArmed(false);
  }, [connector.id]);

  const handleClick = useCallback(async () => {
    if (deleting) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setDeleting(true);
    try {
      const res = await apiClient.delete(`/connectors/${connector.id}`);
      if (res.error) {
        onError(res.error.message ?? 'Delete failed');
      } else {
        onDeleted();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setArmed(false);
    }
  }, [armed, connector.id, deleting, onDeleted, onError]);

  return (
    <button
      type="button"
      className={`${btnSecondary} ${armed ? 'border-error text-error' : ''}`}
      disabled={!canWrite || deleting}
      onClick={() => void handleClick()}
      title={armed ? 'Click again to confirm permanent delete' : `Delete connector "${connector.name}"`}
    >
      {deleting ? 'Deleting…' : armed ? 'Confirm delete?' : 'Disconnect'}
    </button>
  );
}

function StatusLine({ connector }: { connector: ConnectorRow }): React.ReactElement {
  const fmt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : null);
  const verified = fmt(connector.lastVerifiedAt);
  return (
    <div className="space-y-1 text-xs text-[var(--color-on-surface-variant)]">
      <div className="flex items-center gap-2">
        <span className="rounded border border-[var(--color-outline-variant)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
          {connector.status}
        </span>
        {verified && <span>Last verified {verified}</span>}
      </div>
      {connector.lastVerifyError && (
        <p className="text-error">{connector.lastVerifyError}</p>
      )}
    </div>
  );
}

export function ConnectorDetail({
  connector,
  canWrite,
  orgId,
  onSaved,
  onDeleted,
}: ConnectorDetailProps): React.ReactElement {
  const [deleteError, setDeleteError] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--color-outline-variant)]/30 px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[var(--color-on-surface)]">
              {connector.name}
            </h2>
            <p className="mt-1 text-xs text-[var(--color-on-surface-variant)]">
              <span className="uppercase tracking-wide">{connector.type}</span>
              {connector.capabilities && connector.capabilities.length > 0 && (
                <> · {connector.capabilities.length} capabilities</>
              )}
            </p>
          </div>
          <DeleteConnectorButton
            connector={connector}
            canWrite={canWrite}
            onDeleted={onDeleted}
            onError={setDeleteError}
          />
        </div>
        <div className="mt-2">
          <StatusLine connector={connector} />
        </div>
        {deleteError && (
          <div className="mt-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error" role="alert">
            {deleteError}
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-8">
        {connector.type === 'github' ? (
          <GithubConnectorPanel
            canWrite={canWrite}
            onChanged={onSaved}
            hasActiveConnector={connector.status === 'active'}
          />
        ) : (
          <ConnectorConfigSection
            connector={connector}
            canWrite={canWrite}
            onSaved={onSaved}
          />
        )}

        <PermissionsSection
          connectorId={connector.id}
          connectorType={connector.type}
          orgId={orgId}
          disabled={!canWrite}
        />
      </div>
    </div>
  );
}

export default ConnectorDetail;
