import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { api } from '../api/client.js';

// Types

interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: string;
  authProvider: string;
  teams: string[];
  lastLoginAt: string;
  createdAt: string;
  disabled?: boolean;
}

interface Team {
  id: string;
  name: string;
  members: { userId: string; role: 'owner' | 'member' }[];
  permissions: string[];
  createdAt: string;
}

interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  actorEmail?: string;
  targetEmail?: string;
  provider?: string;
  details?: Record<string, unknown>;
}

type Tab = 'users' | 'teams' | 'audit';

const ROLES = ['admin', 'operator', 'investigator', 'viewer', 'readonly'] as const;

const ROLE_COLORS: Record<string, string> = {
  admin: 'bg-error/15 text-error',
  operator: 'bg-tertiary/15 text-tertiary',
  investigator: 'bg-primary/15 text-primary',
  viewer: 'bg-[var(--color-outline-variant)] text-[var(--color-on-surface)]',
  readonly: 'bg-[var(--color-surface-high)] text-on-surface-variant',
};

const PROVIDER_LABELS: Record<string, string> = {
  local: 'Password',
  github: 'GitHub',
  google: 'Google',
  oidc: 'SSO',
  saml: 'SAML',
};

// Users Tab

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ email: '', name: '', role: 'viewer', password: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ users: User[] }>('/admin/users');
      setUsers(data.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      await api.patch(`/admin/users/${userId}`, { role });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update role');
    }
  };

  const handleToggleDisable = async (user: User) => {
    try {
      await api.patch(`/admin/users/${user.id}`, { disabled: !user.disabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update user');
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('Delete this user? This action cannot be undone.')) return;
    try {
      await api.delete(`/admin/users/${userId}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete user');
    }
  };

  const handleInvite = async () => {
    setSaving(true);
    try {
      await api.post('/admin/users', invite);
      setInviteOpen(false);
      setInvite({ email: '', name: '', role: 'viewer', password: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-on-surface-variant text-sm py-8 text-center">Loading users…</div>;

  return (
    <div>
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-error/10 border border-error/30 text-error text-sm">{error}</div>
      )}

      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-on-surface-variant">{users.length} user{users.length === 1 ? '' : 's'}</p>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="px-4 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-medium hover:opacity-90 transition-colors"
        >
          Invite user
        </button>
      </div>

      {inviteOpen && (
        <div className="mb-6 p-4 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-surface-high)] space-y-3">
          <h3 className="font-semibold text-[var(--color-primary)]">Invite new user</h3>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="email"
              placeholder="Email"
              value={invite.email}
              onChange={(e) => setInvite((i) => ({ ...i, email: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
            />
            <input
              type="text"
              placeholder="Name"
              value={invite.name}
              onChange={(e) => setInvite((i) => ({ ...i, name: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
            />
            <input
              type="password"
              placeholder="Initial password (optional)"
              value={invite.password}
              onChange={(e) => setInvite((i) => ({ ...i, password: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
            />
            <select
              value={invite.role}
              onChange={(e) => setInvite((i) => ({ ...i, role: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void handleInvite()}
              disabled={saving || !invite.email || !invite.name}
              className="px-4 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {saving ? 'Creating…' : 'Create user'}
            </button>
            <button
              type="button"
              onClick={() => setInviteOpen(false)}
              className="px-4 py-2 text-sm text-on-surface-variant hover:text-[var(--color-on-surface)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Users table */}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-outline-variant)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-high)] border-b border-[var(--color-outline-variant)]">
            <tr>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">User</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Provider</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Role</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Last login</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-outline-variant)]">
            {users.map((u) => (
              <tr key={u.id} className={`${u.disabled ? 'opacity-50' : ''}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {u.avatarUrl ? (
                      <img src={u.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-[var(--color-primary)]/20 flex items-center justify-center text-xs font-bold text-[var(--color-primary)]">
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className="font-medium text-[var(--color-on-surface)]">{u.name}</div>
                      <div className="text-on-surface-variant text-xs">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-on-surface-variant">{PROVIDER_LABELS[u.authProvider] ?? u.authProvider}</td>
                <td className="px-4 py-3">
                  <select
                    value={u.role}
                    onChange={(e) => { void handleRoleChange(u.id, e.target.value); }}
                    className={`px-3 py-1 rounded-full text-xs focus:outline-none focus:ring-2 cursor-pointer ${ROLE_COLORS[u.role] ?? 'bg-surface-high text-on-surface'}`}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3 text-on-surface-variant text-xs">{new Date(u.lastLoginAt).toLocaleString()}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { void handleToggleDisable(u); }}
                      className="text-xs text-on-surface-variant hover:text-[var(--color-on-surface)] underline"
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleDelete(u.id); }}
                      className="text-xs text-error hover:opacity-80 underline"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="py-8 text-center text-on-surface-variant text-sm">No users found</div>
        )}
      </div>
    </div>
  );
}

// Teams Tab

function TeamsTab() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [data, users] = await Promise.all([
        api.get<{ teams: Team[] }>('/admin/teams'),
        api.get<{ users: User[] }>('/admin/users'),
      ]);
      setTeams(data.teams);
      setUsers(users.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load teams');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!newTeamName.trim()) return;
    setSaving(true);
    try {
      await api.post('/admin/teams', { name: newTeamName });
      setCreating(false);
      setNewTeamName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create team');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (teamId: string) => {
    if (!confirm('Delete this team?')) return;
    try {
      await api.delete(`/admin/teams/${teamId}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete team');
    }
  };

  const handleAddMember = async (teamId: string, userId: string) => {
    try {
      await api.post(`/admin/teams/${teamId}/members`, { userId, role: 'member' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add member');
    }
  };

  const handleRemoveMember = async (teamId: string, userId: string) => {
    try {
      await api.delete(`/admin/teams/${teamId}/members/${userId}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member');
    }
  };

  if (loading) return <div className="text-on-surface-variant text-sm py-8 text-center">Loading teams…</div>;

  return (
    <div>
      {error && <div className="mb-4 px-4 py-3 rounded-lg bg-error/10 border border-error/30 text-error text-sm">{error}</div>}

      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-on-surface-variant">{teams.length} team{teams.length === 1 ? '' : 's'}</p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="px-4 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-medium hover:opacity-90 transition-colors"
        >
          New team
        </button>
      </div>

      {creating && (
        <div className="mb-6 p-4 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-surface-high)] flex gap-2">
          <input
            type="text"
            placeholder="Team name"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving || !newTeamName.trim()}
            className="px-4 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)} className="px-3 py-2 text-sm text-on-surface-variant">Cancel</button>
        </div>
      )}

      <div className="space-y-4">
        {teams.map((team) => {
          const memberUsers = team.members.map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) }));
          const nonMembers = users.filter((u) => !team.members.some((m) => m.userId === u.id));
          return (
            <div key={team.id} className="border border-[var(--color-outline-variant)] rounded-xl p-4 bg-[var(--color-surface-highest)]">
              <div className="flex justify-between items-center mb-3">
                <div className="font-semibold text-[var(--color-on-surface)]">{team.name}</div>
                <button type="button" onClick={() => { void handleDelete(team.id); }} className="text-xs text-error hover:opacity-80">
                  Delete
                </button>
              </div>

              <div className="space-y-2">
                {memberUsers.map(({ user, role }) => (
                  user ? (
                    <div key={user.id} className="flex items-center gap-2 text-sm">
                      <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">
                        {user.name.charAt(0)}
                      </div>
                      <div className="flex-1">
                        <div className="text-[var(--color-on-surface)]">{user.name}</div>
                        <span className="text-xs text-on-surface-variant">{role}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => { void handleRemoveMember(team.id, user.id); }}
                        className="text-xs text-on-surface-variant hover:text-error"
                      >
                        Remove
                      </button>
                    </div>
                  ) : null
                ))}

                {nonMembers.length > 0 && (
                  <select
                    onChange={(e) => { if (e.target.value) void handleAddMember(team.id, e.target.value); e.target.value = ''; }}
                    className="w-full mt-2 px-3 py-1.5 rounded-lg border border-dashed border-[var(--color-outline-variant)] text-sm bg-[var(--color-surface-high)] focus:outline-none"
                    defaultValue=""
                  >
                    <option value="">Add member</option>
                    {nonMembers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}

        {teams.length === 0 && (
          <div className="py-8 text-center text-on-surface-variant text-sm">No teams yet</div>
        )}
      </div>
    </div>
  );
}

// Audit Log Tab

function AuditLogTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const load = useCallback(async (off: number) => {
    try {
      const data = await api.get<{ entries: AuditEntry[]; total: number }>(
        `/admin/audit-log?limit=${LIMIT}&offset=${off}`,
      );
      setEntries(data.entries);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(offset); }, [load, offset]);

  const ACTION_COLORS: Record<string, string> = {
    login: 'text-secondary',
    logout: 'text-on-surface-variant',
    login_failed: 'text-error',
    user_created: 'text-primary',
    user_deleted: 'text-error',
    role_changed: 'text-tertiary',
    team_created: 'text-primary',
    team_deleted: 'text-error',
  };

  if (loading) return <div className="text-on-surface-variant text-sm py-8 text-center">Loading audit log…</div>;

  return (
    <div>
      <div className="text-sm text-on-surface-variant mb-4">{total} total entr{total === 1 ? 'y' : 'ies'}</div>
      <div className="overflow-x-auto rounded-xl border border-[var(--color-outline-variant)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-high)] border-b border-[var(--color-outline-variant)]">
            <tr>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Time</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Action</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Actor</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Target</th>
              <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Provider</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-outline-variant)]">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2.5 text-on-surface-variant text-xs whitespace-nowrap">{new Date(e.timestamp).toLocaleString()}</td>
                <td className={`px-4 py-2.5 font-medium text-xs ${ACTION_COLORS[e.action] ?? 'text-on-surface'}`}>{e.action.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2.5 text-xs text-[var(--color-on-surface)]">{e.actorEmail ?? '-'}</td>
                <td className="px-4 py-2.5 text-xs text-[var(--color-on-surface)]">{e.targetEmail ?? '-'}</td>
                <td className="px-4 py-2.5 text-xs text-[var(--color-on-surface)]">{e.provider ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {entries.length === 0 && (
        <div className="py-8 text-center text-on-surface-variant text-sm">No audit events yet</div>
      )}

      {total > LIMIT && (
        <div className="flex justify-center gap-3 mt-4">
          <button
            type="button"
            onClick={() => { const o = Math.max(0, offset - LIMIT); setOffset(o); void load(o); }}
            disabled={offset === 0}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-[var(--color-on-surface)] disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-on-surface-variant self-center">
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <button
            type="button"
            onClick={() => { const o = offset + LIMIT; setOffset(o); void load(o); }}
            disabled={offset + LIMIT >= total}
            className="px-4 py-2 text-sm text-on-surface-variant hover:text-[var(--color-on-surface)] disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// Main Admin page

export default function Admin() {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('users');

  useEffect(() => {
    if (!isAdmin) navigate('/', { replace: true });
  }, [isAdmin, navigate]);

  if (!user || !isAdmin) return null;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'users', label: 'Users' },
    { id: 'teams', label: 'Teams' },
    { id: 'audit', label: 'Audit Log' },
  ];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[var(--color-on-surface)]">Administration</h1>
        <p className="text-on-surface-variant mt-1">Manage users, teams, and access control</p>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-6 border-b border-[var(--color-outline-variant)]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-on-surface-variant hover:text-[var(--color-on-surface)] hover:border-[var(--color-outline-variant)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'teams' && <TeamsTab />}
      {tab === 'audit' && <AuditLogTab />}
    </div>
  );
}
