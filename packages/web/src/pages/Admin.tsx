import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';

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
  admin: 'bg-red-900/30 text-red-400',
  operator: 'bg-amber-900/30 text-amber-400',
  investigator: 'bg-violet-900/30 text-violet-400',
  viewer: 'bg-[#2A2A3E] text-[#E8E8DE]',
  readonly: 'bg-[#1C1C2E] text-[#B8B8A0]',
};

const PROVIDER_LABELS: Record<string, string> = {
  local: 'Password',
  github: 'GitHub',
  google: 'Google',
  oidc: 'SSO',
  saml: 'SAML',
};

// API helpers

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const token = (() => {
    try {
      const raw = localStorage.getItem('agentic_obs_auth');
      if (raw) return (JSON.parse(raw) as { tokens?: { accessToken?: string } }).tokens?.accessToken;
    } catch {
      return null;
    }
    return null;
  })();
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
    throw new Error(err.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

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
      const data = await apiFetch<{ users: User[] }>('/api/admin/users');
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
      await apiFetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update role');
    }
  };

  const handleToggleDisable = async (user: User) => {
    try {
      await apiFetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled: !user.disabled }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update user');
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm('Delete this user? This action cannot be undone.')) return;
    try {
      await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete user');
    }
  };

  const handleInvite = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(invite),
      });
      setInviteOpen(false);
      setInvite({ email: '', name: '', role: 'viewer', password: '' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-[#B8B8A0] text-sm py-8 text-center">Loading users…</div>;

  return (
    <div>
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-sm">{error}</div>
      )}

      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-[#B8B8A0]">{users.length} user{users.length === 1 ? '' : 's'}</p>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          Invite user
        </button>
      </div>

      {inviteOpen && (
        <div className="mb-6 p-4 rounded-xl border border-[#4F46E5]/30 bg-[#1C1C2E] space-y-3">
          <h3 className="font-semibold text-[#6366F1]">Invite new user</h3>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="email"
              placeholder="Email"
              value={invite.email}
              onChange={(e) => setInvite((i) => ({ ...i, email: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#141420] text-[#E8E8DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            />
            <input
              type="text"
              placeholder="Name"
              value={invite.name}
              onChange={(e) => setInvite((i) => ({ ...i, name: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#141420] text-[#E8E8DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            />
            <input
              type="password"
              placeholder="Initial password (optional)"
              value={invite.password}
              onChange={(e) => setInvite((i) => ({ ...i, password: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#141420] text-[#E8E8DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            />
            <select
              value={invite.role}
              onChange={(e) => setInvite((i) => ({ ...i, role: e.target.value }))}
              className="px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#141420] text-[#E8E8DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void handleInvite()}
              disabled={saving || !invite.email || !invite.name}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create user'}
            </button>
            <button
              type="button"
              onClick={() => setInviteOpen(false)}
              className="px-4 py-2 text-sm text-[#B8B8A0] hover:text-[#E8E8DE]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Users table */}
      <div className="overflow-x-auto rounded-xl border border-[#2A2A3E]">
        <table className="w-full text-sm">
          <thead className="bg-[#1C1C2E] border-b border-[#2A2A3E]">
            <tr>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">User</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Provider</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Role</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Last login</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2A2A3E]">
            {users.map((u) => (
              <tr key={u.id} className={`${u.disabled ? 'opacity-50' : ''}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {u.avatarUrl ? (
                      <img src={u.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-[#6366F1]/20 flex items-center justify-center text-xs font-bold text-[#6366F1]">
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className="font-medium text-[#E8E8DE]">{u.name}</div>
                      <div className="text-[#B8B8A0] text-xs">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-[#B8B8A0]">{PROVIDER_LABELS[u.authProvider] ?? u.authProvider}</td>
                <td className="px-4 py-3">
                  <select
                    value={u.role}
                    onChange={(e) => { void handleRoleChange(u.id, e.target.value); }}
                    className={`px-3 py-1 rounded-full text-xs focus:outline-none focus:ring-2 cursor-pointer ${ROLE_COLORS[u.role] ?? 'bg-slate-700 text-white'}`}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3 text-[#B8B8A0] text-xs">{new Date(u.lastLoginAt).toLocaleString()}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { void handleToggleDisable(u); }}
                      className="text-xs text-[#B8B8A0] hover:text-[#E8E8DE] underline"
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleDelete(u.id); }}
                      className="text-xs text-red-500 hover:text-red-700 underline"
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
          <div className="py-8 text-center text-[#B8B8A0] text-sm">No users found</div>
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
        apiFetch<{ teams: Team[] }>('/api/admin/teams'),
        apiFetch<{ users: User[] }>('/api/admin/users'),
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
      await apiFetch('/api/admin/teams', { method: 'POST', body: JSON.stringify({ name: newTeamName }) });
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
      await apiFetch(`/api/admin/teams/${teamId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete team');
    }
  };

  const handleAddMember = async (teamId: string, userId: string) => {
    try {
      await apiFetch(`/api/admin/teams/${teamId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId, role: 'member' }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add member');
    }
  };

  const handleRemoveMember = async (teamId: string, userId: string) => {
    try {
      await apiFetch(`/api/admin/teams/${teamId}/members/${userId}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member');
    }
  };

  if (loading) return <div className="text-[#B8B8A0] text-sm py-8 text-center">Loading teams…</div>;

  return (
    <div>
      {error && <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-sm">{error}</div>}

      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-[#B8B8A0]">{teams.length} team{teams.length === 1 ? '' : 's'}</p>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          New team
        </button>
      </div>

      {creating && (
        <div className="mb-6 p-4 rounded-xl border border-[#4F46E5]/30 bg-[#1C1C2E] flex gap-2">
          <input
            type="text"
            placeholder="Team name"
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border border-[#2A2A3E] bg-[#141420] text-[#E8E8DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#6366F1]/30 focus:border-[#6366F1]"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving || !newTeamName.trim()}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
          >
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)} className="px-3 py-2 text-sm text-[#B8B8A0]">Cancel</button>
        </div>
      )}

      <div className="space-y-4">
        {teams.map((team) => {
          const memberUsers = team.members.map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) }));
          const nonMembers = users.filter((u) => !team.members.some((m) => m.userId === u.id));
          return (
            <div key={team.id} className="border border-[#2A2A3E] rounded-xl p-4 bg-[#141420]">
              <div className="flex justify-between items-center mb-3">
                <div className="font-semibold text-[#E8E8DE]">{team.name}</div>
                <button type="button" onClick={() => { void handleDelete(team.id); }} className="text-xs text-red-500 hover:text-red-700">
                  Delete
                </button>
              </div>

              <div className="space-y-2">
                {memberUsers.map(({ user, role }) => (
                  user ? (
                    <div key={user.id} className="flex items-center gap-2 text-sm">
                      <div className="h-8 w-8 rounded-full bg-indigo-700/20 flex items-center justify-center text-xs font-bold text-indigo-300">
                        {user.name.charAt(0)}
                      </div>
                      <div className="flex-1">
                        <div className="text-[#E8E8DE]">{user.name}</div>
                        <span className="text-xs text-[#B8B8A0]">{role}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => { void handleRemoveMember(team.id, user.id); }}
                        className="text-xs text-[#B8B8A0] hover:text-red-400"
                      >
                        Remove
                      </button>
                    </div>
                  ) : null
                ))}

                {nonMembers.length > 0 && (
                  <select
                    onChange={(e) => { if (e.target.value) void handleAddMember(team.id, e.target.value); e.target.value = ''; }}
                    className="w-full mt-2 px-3 py-1.5 rounded-lg border border-dashed border-[#2A2A3E] text-sm bg-[#1C1C2E] focus:outline-none"
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
          <div className="py-8 text-center text-[#B8B8A0] text-sm">No teams yet</div>
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
      const data = await apiFetch<{ entries: AuditEntry[]; total: number }>(
        `/api/admin/audit-log?limit=${LIMIT}&offset=${off}`,
      );
      setEntries(data.entries);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(offset); }, [load, offset]);

  const ACTION_COLORS: Record<string, string> = {
    login: 'text-emerald-600',
    logout: 'text-slate-500',
    login_failed: 'text-red-600',
    user_created: 'text-blue-600',
    user_deleted: 'text-red-600',
    role_changed: 'text-amber-600',
    team_created: 'text-blue-600',
    team_deleted: 'text-red-600',
  };

  if (loading) return <div className="text-[#B8B8A0] text-sm py-8 text-center">Loading audit log…</div>;

  return (
    <div>
      <div className="text-sm text-[#B8B8A0] mb-4">{total} total entr{total === 1 ? 'y' : 'ies'}</div>
      <div className="overflow-x-auto rounded-xl border border-[#2A2A3E]">
        <table className="w-full text-sm">
          <thead className="bg-[#1C1C2E] border-b border-[#2A2A3E]">
            <tr>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Time</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Action</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Actor</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Target</th>
              <th className="text-left px-4 py-3 text-[#B8B8A0] font-medium">Provider</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2A2A3E]">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2.5 text-[#B8B8A0] text-xs whitespace-nowrap">{new Date(e.timestamp).toLocaleString()}</td>
                <td className={`px-4 py-2.5 font-medium text-xs ${ACTION_COLORS[e.action] ?? 'text-slate-700'}`}>{e.action.replace(/_/g, ' ')}</td>
                <td className="px-4 py-2.5 text-xs text-[#E8E8DE]">{e.actorEmail ?? '-'}</td>
                <td className="px-4 py-2.5 text-xs text-[#E8E8DE]">{e.targetEmail ?? '-'}</td>
                <td className="px-4 py-2.5 text-xs text-[#E8E8DE]">{e.provider ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {entries.length === 0 && (
        <div className="py-8 text-center text-[#B8B8A0] text-sm">No audit events yet</div>
      )}

      {total > LIMIT && (
        <div className="flex justify-center gap-3 mt-4">
          <button
            type="button"
            onClick={() => { const o = Math.max(0, offset - LIMIT); setOffset(o); void load(o); }}
            disabled={offset === 0}
            className="px-4 py-2 text-sm text-[#B8B8A0] hover:text-[#E8E8DE] disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-[#B8B8A0] self-center">
            {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
          </span>
          <button
            type="button"
            onClick={() => { const o = offset + LIMIT; setOffset(o); void load(o); }}
            disabled={offset + LIMIT >= total}
            className="px-4 py-2 text-sm text-[#B8B8A0] hover:text-[#E8E8DE] disabled:opacity-40"
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
        <h1 className="text-2xl font-bold text-[#E8E8DE]">Administration</h1>
        <p className="text-[#B8B8A0] mt-1">Manage users, teams, and access control</p>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mb-6 border-b border-[#2A2A3E]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-[#6366F1] text-[#6366F1]'
                : 'border-transparent text-[#B8B8A0] hover:text-[#E8E8DE] hover:border-[#2A2A3E]'
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
