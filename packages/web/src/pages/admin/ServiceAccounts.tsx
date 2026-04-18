/**
 * T8.3 — Admin / Service Accounts tab.
 *
 * Wraps the `/api/serviceaccounts/*` endpoints. The token-create flow
 * surfaces the plaintext token exactly once, matching Grafana's behaviour
 * mandated in docs/auth-perm-design/09-frontend.md §T8.3.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import {
  Badge,
  Drawer,
  EmptyState,
  ErrorBanner,
  LoadingRow,
  Modal,
  Pager,
  PrimaryButton,
  RowActions,
  SecondaryButton,
  Select,
  TextInput,
} from './_ui.js';
import { useHasPermission, useIsServerAdmin } from './_gate.js';
import {
  type PagedResponse,
  type ServiceAccountDTO,
  type ServiceAccountTokenDTO,
  expiryToSeconds,
  formatLastSeen,
  serviceAccountsUrl,
} from './_shared.js';

const ROLES = ['Admin', 'Editor', 'Viewer', 'None'] as const;

export default function ServiceAccounts(): React.ReactElement {
  const has = useHasPermission();
  const isServerAdmin = useIsServerAdmin();
  const canView = has('serviceaccounts:read') || isServerAdmin;
  const canCreate = has('serviceaccounts:create') || isServerAdmin;
  const canWrite = has('serviceaccounts:write') || isServerAdmin;
  const canDelete = has('serviceaccounts:delete') || isServerAdmin;

  const [items, setItems] = useState<ServiceAccountDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ServiceAccountDTO | null>(null);
  const [tokenTarget, setTokenTarget] = useState<ServiceAccountDTO | null>(null);

  const perpage = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = serviceAccountsUrl({ query, page, perpage });
      const data = await api.get<
        PagedResponse<ServiceAccountDTO> & { serviceAccounts?: ServiceAccountDTO[] }
      >(url);
      const list = data.items ?? data.serviceAccounts ?? [];
      setItems(list);
      setTotal(data.totalCount ?? data.total ?? list.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load service accounts');
    } finally {
      setLoading(false);
    }
  }, [query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (sa: ServiceAccountDTO): Promise<void> => {
    if (!window.confirm(`Delete service account ${sa.name}?`)) return;
    try {
      await api.delete(`/serviceaccounts/${sa.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  if (!canView) {
    return <EmptyState label="You don't have permission to view service accounts." />;
  }

  return (
    <div>
      <ErrorBanner message={error} />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(queryInput.trim());
            setPage(1);
          }}
          className="flex-1 flex gap-2"
        >
          <TextInput
            placeholder="Search service accounts"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            className="flex-1"
          />
          <SecondaryButton type="submit">Search</SecondaryButton>
        </form>
        {canCreate && (
          <PrimaryButton onClick={() => setCreateOpen(true)}>+ New service account</PrimaryButton>
        )}
      </div>

      {loading ? (
        <LoadingRow />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-outline">
          <table className="w-full text-sm">
            <thead className="bg-surface-high border-b border-outline">
              <tr>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Name</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Role</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Created</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Tokens</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Status</th>
                <th className="text-right px-4 py-3 text-on-surface-variant font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline">
              {items.map((sa) => (
                <tr key={sa.id} className={sa.isDisabled ? 'opacity-60' : ''}>
                  <td className="px-4 py-2.5 text-on-surface font-medium">{sa.name}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant="primary">{sa.role}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-on-surface-variant text-xs">
                    {formatLastSeen(sa.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-on-surface-variant">{sa.tokens}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={sa.isDisabled ? 'error' : 'success'}>
                      {sa.isDisabled ? 'Disabled' : 'Active'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <RowActions
                      actions={[
                        {
                          label: 'Manage tokens',
                          onSelect: () => setTokenTarget(sa),
                          disabled: !canWrite,
                        },
                        { label: 'Edit', onSelect: () => setEditTarget(sa), disabled: !canWrite },
                        {
                          label: 'Delete',
                          danger: true,
                          onSelect: () => void handleDelete(sa),
                          disabled: !canDelete,
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <EmptyState label="No service accounts yet." />}
        </div>
      )}

      <Pager page={page} perpage={perpage} total={total} onChange={setPage} />

      {createOpen && (
        <CreateServiceAccountModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      )}
      {editTarget && (
        <EditServiceAccountModal
          sa={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void load();
          }}
        />
      )}
      {tokenTarget && (
        <TokensDrawer
          sa={tokenTarget}
          onClose={() => setTokenTarget(null)}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function CreateServiceAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [role, setRole] = useState<string>('Viewer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open onClose={onClose} title="New service account">
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={saving || !name.trim()}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.post('/serviceaccounts', { name, role });
              onCreated();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to create service account');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Creating…' : 'Create'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function EditServiceAccountModal({
  sa,
  onClose,
  onSaved,
}: {
  sa: ServiceAccountDTO;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const [name, setName] = useState(sa.name);
  const [role, setRole] = useState(sa.role);
  const [disabled, setDisabled] = useState(sa.isDisabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open onClose={onClose} title={`Edit — ${sa.name}`}>
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          Disabled
        </label>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.patch(`/serviceaccounts/${sa.id}`, { name, role, isDisabled: disabled });
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to save');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function TokensDrawer({
  sa,
  onClose,
  canWrite,
}: {
  sa: ServiceAccountDTO;
  onClose: () => void;
  canWrite: boolean;
}): React.ReactElement {
  const [tokens, setTokens] = useState<ServiceAccountTokenDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [plaintext, setPlaintext] = useState<{ id: string; name: string; key: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<
        ServiceAccountTokenDTO[] | { tokens: ServiceAccountTokenDTO[] }
      >(`/serviceaccounts/${sa.id}/tokens`);
      const list = Array.isArray(data) ? data : (data.tokens ?? []);
      setTokens(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  }, [sa.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (t: ServiceAccountTokenDTO): Promise<void> => {
    if (!window.confirm(`Revoke token "${t.name}"?`)) return;
    try {
      await api.delete(`/serviceaccounts/${sa.id}/tokens/${t.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke token');
    }
  };

  return (
    <Drawer open onClose={onClose} title={`Tokens — ${sa.name}`}>
      <ErrorBanner message={error} />

      {plaintext && (
        <div className="mb-4 p-4 rounded-xl border border-tertiary/40 bg-tertiary/10">
          <div className="text-sm font-semibold text-on-surface mb-1">
            Token "{plaintext.name}" created
          </div>
          <div className="text-xs text-on-surface-variant mb-3">
            Save it now. You won't see it again.
          </div>
          <div className="flex gap-2 items-center">
            <code className="flex-1 px-3 py-2 rounded bg-surface-highest text-xs font-mono break-all">
              {plaintext.key}
            </code>
            <SecondaryButton
              onClick={() => {
                if (typeof navigator !== 'undefined' && navigator.clipboard) {
                  void navigator.clipboard.writeText(plaintext.key);
                }
              }}
            >
              Copy
            </SecondaryButton>
            <SecondaryButton onClick={() => setPlaintext(null)}>Dismiss</SecondaryButton>
          </div>
        </div>
      )}

      <div className="flex justify-end mb-3">
        {canWrite && (
          <PrimaryButton onClick={() => setCreateOpen(true)}>+ Create token</PrimaryButton>
        )}
      </div>

      {loading ? (
        <LoadingRow />
      ) : tokens.length === 0 ? (
        <EmptyState label="No tokens for this service account." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-on-surface-variant border-b border-outline">
              <th className="py-2">Name</th>
              <th className="py-2">Expires</th>
              <th className="py-2">Last used</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline">
            {tokens.map((t) => (
              <tr key={t.id}>
                <td className="py-2 text-on-surface">{t.name}</td>
                <td className="py-2 text-on-surface-variant text-xs">
                  {t.expiration ? new Date(t.expiration).toLocaleDateString() : 'Never'}
                  {t.hasExpired && <span className="ml-1 text-error">(expired)</span>}
                </td>
                <td className="py-2 text-on-surface-variant text-xs">
                  {formatLastSeen(t.lastUsedAt)}
                </td>
                <td className="py-2 text-right">
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => void handleDelete(t)}
                      className="text-xs text-error hover:opacity-80"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {createOpen && (
        <CreateTokenModal
          sa={sa}
          onClose={() => setCreateOpen(false)}
          onCreated={(t) => {
            setCreateOpen(false);
            setPlaintext(t);
            void load();
          }}
        />
      )}
    </Drawer>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function CreateTokenModal({
  sa,
  onClose,
  onCreated,
}: {
  sa: ServiceAccountDTO;
  onClose: () => void;
  onCreated: (t: { id: string; name: string; key: string }) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<'never' | '30d' | '90d' | '365d' | 'custom'>('90d');
  const [customDays, setCustomDays] = useState<number>(30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open onClose={onClose} title={`New token — ${sa.name}`}>
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput placeholder="Token name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={choice} onChange={(e) => setChoice(e.target.value as typeof choice)}>
          <option value="never">Never expires</option>
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="365d">365 days</option>
          <option value="custom">Custom</option>
        </Select>
        {choice === 'custom' && (
          <TextInput
            type="number"
            min={1}
            placeholder="Days"
            value={customDays}
            onChange={(e) => setCustomDays(Number(e.target.value))}
          />
        )}
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={saving || !name.trim()}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              const secondsToLive = expiryToSeconds(choice, customDays);
              const body: Record<string, unknown> = { name };
              if (secondsToLive !== null) body.secondsToLive = secondsToLive;
              const created = await api.post<{ id: string; name: string; key: string }>(
                `/serviceaccounts/${sa.id}/tokens`,
                body,
              );
              onCreated(created);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to create token');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Creating…' : 'Create token'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

