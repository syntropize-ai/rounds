/**
 * T8.3 — Admin / Users tab.
 *
 * Lists either the current-org users (`GET /api/org/users`) or the server-wide
 * user directory (`GET /api/admin/users`) for server admins. Exposes row
 * actions mandated by docs/auth-perm-design/09-frontend.md §T8.3.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import {
  Badge,
  DangerButton,
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
  type AdminUserDTO,
  type OrgUserDTO,
  type PagedResponse,
  authMethodLabel,
  formatLastSeen,
  usersListUrl,
} from './_shared.js';

interface UserRow {
  id: string;
  login: string;
  email: string;
  name: string;
  role: string;
  authLabels: string[];
  lastSeenAt?: string | null;
  isDisabled: boolean;
  avatarUrl?: string;
}

const ORG_ROLES = ['Admin', 'Editor', 'Viewer', 'None'] as const;

function rowsFromOrgUsers(items: OrgUserDTO[]): UserRow[] {
  return items.map((u) => ({
    id: u.userId,
    login: u.login,
    email: u.email,
    name: u.name,
    role: u.role ?? 'None',
    authLabels: u.authLabels ?? [],
    lastSeenAt: u.lastSeenAt ?? null,
    isDisabled: Boolean(u.isDisabled),
    avatarUrl: u.avatarUrl,
  }));
}

function rowsFromAdminUsers(items: AdminUserDTO[]): UserRow[] {
  return items.map((u) => ({
    id: u.id,
    login: u.login,
    email: u.email,
    name: u.name,
    role: u.isAdmin || u.isGrafanaAdmin ? 'Server Admin' : '—',
    authLabels: u.authLabels ?? [],
    lastSeenAt: u.lastSeenAt ?? null,
    isDisabled: Boolean(u.isDisabled),
    avatarUrl: u.avatarUrl,
  }));
}

export default function Users(): React.ReactElement {
  const has = useHasPermission();
  const isServerAdmin = useIsServerAdmin();
  const canView = has('users:read') || has('org.users:read') || isServerAdmin;
  const canCreate = has('users:create') || isServerAdmin;
  const canWrite = has('users:write') || has('org.users:write') || isServerAdmin;
  const canDelete = has('users:delete') || has('org.users:remove') || isServerAdmin;

  const [mode, setMode] = useState<'org' | 'admin'>('org');
  const [query, setQuery] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [page, setPage] = useState(1);
  const [perpage] = useState(20);

  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = usersListUrl(mode, { query, page, perpage });
      const data = await api.get<
        PagedResponse<OrgUserDTO | AdminUserDTO> & { users?: Array<OrgUserDTO | AdminUserDTO> }
      >(url);
      // Servers have used both `items` and `users` keys; tolerate either.
      const raw = data.items ?? data.users ?? [];
      const parsed =
        mode === 'admin'
          ? rowsFromAdminUsers(raw as AdminUserDTO[])
          : rowsFromOrgUsers(raw as OrgUserDTO[]);
      setRows(parsed);
      setTotal(data.totalCount ?? data.total ?? parsed.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [mode, query, page, perpage]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault();
    setQuery(queryInput.trim());
    setPage(1);
  };

  const handleChangeRole = async (u: UserRow, role: string): Promise<void> => {
    if (mode === 'admin') {
      // Cross-org directory can't PATCH org role without picking an org; skip.
      return;
    }
    try {
      await api.patch(`/org/users/${u.id}`, { role });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change role');
    }
  };

  const handleToggleDisable = async (u: UserRow): Promise<void> => {
    try {
      if (u.isDisabled) {
        await api.post(`/admin/users/${u.id}/enable`, {});
      } else {
        await api.post(`/admin/users/${u.id}/disable`, {});
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle user');
    }
  };

  const handleResetPassword = async (u: UserRow): Promise<void> => {
    try {
      await api.post(`/admin/users/${u.id}/password`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset password');
    }
  };

  const handleRevokeSessions = async (u: UserRow): Promise<void> => {
    try {
      await api.post(`/admin/users/${u.id}/logout`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke sessions');
    }
  };

  const handleDelete = async (u: UserRow): Promise<void> => {
    if (!window.confirm(`Delete user ${u.login}? This cannot be undone.`)) return;
    try {
      if (mode === 'admin') {
        await api.delete(`/admin/users/${u.id}`);
      } else {
        await api.delete(`/org/users/${u.id}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete user');
    }
  };

  const actionsFor = (u: UserRow): Array<{ label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }> => [
    { label: 'Edit', onSelect: () => setEditTarget(u), disabled: !canWrite },
    {
      label: u.isDisabled ? 'Enable' : 'Disable',
      onSelect: () => void handleToggleDisable(u),
      disabled: !canWrite,
    },
    { label: 'Reset password', onSelect: () => void handleResetPassword(u), disabled: !canWrite },
    { label: 'Revoke all sessions', onSelect: () => void handleRevokeSessions(u), disabled: !canWrite },
    { label: 'Delete', danger: true, onSelect: () => void handleDelete(u), disabled: !canDelete },
  ];

  if (!canView) {
    return <EmptyState label="You don't have permission to view users in this org." />;
  }

  return (
    <div>
      <ErrorBanner message={error} />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <TextInput
            placeholder="Search by login, email or name"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            className="flex-1"
          />
          <SecondaryButton type="submit">Search</SecondaryButton>
        </form>

        {isServerAdmin && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span>View:</span>
            <Select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as 'org' | 'admin');
                setPage(1);
              }}
            >
              <option value="org">Current org</option>
              <option value="admin">All users (server admin)</option>
            </Select>
          </div>
        )}

        {canCreate && (
          <PrimaryButton onClick={() => setCreateOpen(true)}>+ New user</PrimaryButton>
        )}
      </div>

      {loading ? (
        <LoadingRow />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-outline">
          <table className="w-full text-sm">
            <thead className="bg-surface-high border-b border-outline">
              <tr>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Login</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Email</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Auth</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Role</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Last seen</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Status</th>
                <th className="text-right px-4 py-3 text-on-surface-variant font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline">
              {rows.map((u) => (
                <tr key={u.id} className={u.isDisabled ? 'opacity-60' : ''}>
                  <td className="px-4 py-2.5 text-on-surface font-medium">{u.login}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge>{authMethodLabel(u.authLabels)}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {mode === 'org' && canWrite && ORG_ROLES.includes(u.role as (typeof ORG_ROLES)[number]) ? (
                      <Select
                        value={u.role}
                        onChange={(e) => void handleChangeRole(u, e.target.value)}
                        className="!py-1 !px-2"
                      >
                        {ORG_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge variant="primary">{u.role}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-on-surface-variant text-xs">
                    {formatLastSeen(u.lastSeenAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={u.isDisabled ? 'error' : 'success'}>
                      {u.isDisabled ? 'Disabled' : 'Active'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <RowActions actions={actionsFor(u)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <EmptyState label="No users match your filters." />}
        </div>
      )}

      <Pager page={page} perpage={perpage} total={total} onChange={setPage} />

      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      )}
      {editTarget && (
        <EditUserModal
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => name.trim() && login.trim() && email.trim() && password.length >= 8,
    [name, login, email, password],
  );

  const handleSubmit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.post('/admin/users', { name, login, email, password });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Create user">
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput placeholder="Login" value={login} onChange={(e) => setLogin(e.target.value)} />
        <TextInput
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextInput
          type="password"
          placeholder="Password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton disabled={!canSubmit || saving} onClick={() => void handleSubmit()}>
          {saving ? 'Creating…' : 'Create user'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const [name, setName] = useState(user.name);
  const [login, setLogin] = useState(user.login);
  const [email, setEmail] = useState(user.email);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/admin/users/${user.id}`, { name, login, email });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit user — ${user.login}`}>
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <TextInput value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Login" />
        <TextInput value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      </div>
      <div className="flex justify-between gap-2 mt-5">
        <DangerButton
          onClick={async () => {
            if (!window.confirm(`Delete user ${user.login}? This cannot be undone.`)) return;
            try {
              await api.delete(`/admin/users/${user.id}`);
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to delete user');
            }
          }}
        >
          Delete
        </DangerButton>
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={saving} onClick={() => void handleSubmit()}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
