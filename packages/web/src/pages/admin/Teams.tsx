/**
 * T8.4 — Admin / Teams tab.
 *
 * Lists teams in the current org (`GET /api/teams/search`) and offers a detail
 * drawer for member management, role assignments, and preferences. External
 * (identity-provider-synced) teams are marked read-only.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  type OrgUserDTO,
  type PagedResponse,
  type RoleDTO,
  type TeamDTO,
  type TeamMemberDTO,
  formatLastSeen,
  rolesListUrl,
  teamPermissionLabel,
  teamsSearchUrl,
  usersListUrl,
} from './_shared.js';

export default function Teams(): React.ReactElement {
  const has = useHasPermission();
  const isServerAdmin = useIsServerAdmin();
  const canView = has('teams:read') || isServerAdmin;
  const canCreate = has('teams:create') || isServerAdmin;
  const canWrite = has('teams:write') || isServerAdmin;
  const canDelete = has('teams:delete') || isServerAdmin;

  const [items, setItems] = useState<TeamDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<TeamDTO | null>(null);
  const perpage = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = teamsSearchUrl({ query, page, perpage });
      const data = await api.get<PagedResponse<TeamDTO> & { teams?: TeamDTO[] }>(url);
      const list = data.items ?? data.teams ?? [];
      setItems(list);
      setTotal(data.totalCount ?? data.total ?? list.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load teams');
    } finally {
      setLoading(false);
    }
  }, [query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (t: TeamDTO): Promise<void> => {
    if (!window.confirm(`Delete team ${t.name}?`)) return;
    try {
      await api.delete(`/teams/${t.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete team');
    }
  };

  if (!canView) {
    return <EmptyState label="You don't have permission to view teams." />;
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
            placeholder="Search teams"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            className="flex-1"
          />
          <SecondaryButton type="submit">Search</SecondaryButton>
        </form>
        {canCreate && <PrimaryButton onClick={() => setCreateOpen(true)}>+ New team</PrimaryButton>}
      </div>

      {loading ? (
        <LoadingRow />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-outline">
          <table className="w-full text-sm">
            <thead className="bg-surface-high border-b border-outline">
              <tr>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Name</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Members</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Created</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">External</th>
                <th className="text-right px-4 py-3 text-on-surface-variant font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline">
              {items.map((t) => {
                const external = t.isExternal || t.external;
                return (
                  <tr key={t.id}>
                    <td className="px-4 py-2.5 text-on-surface font-medium">{t.name}</td>
                    <td className="px-4 py-2.5 text-on-surface-variant">{t.memberCount}</td>
                    <td className="px-4 py-2.5 text-on-surface-variant text-xs">
                      {formatLastSeen(t.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      {external ? (
                        <span title="Managed via external sync">
                          <Badge variant="neutral">External</Badge>
                        </span>
                      ) : (
                        <span className="text-xs text-on-surface-variant">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <RowActions
                        actions={[
                          {
                            label: external ? 'View' : 'View / Edit',
                            onSelect: () => setDrawerTarget(t),
                          },
                          {
                            label: 'Delete',
                            danger: true,
                            onSelect: () => void handleDelete(t),
                            disabled: !canDelete || external,
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length === 0 && <EmptyState label="No teams yet." />}
        </div>
      )}

      <Pager page={page} perpage={perpage} total={total} onChange={setPage} />

      {createOpen && (
        <CreateTeamModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      )}
      {drawerTarget && (
        <TeamDrawer
          team={drawerTarget}
          onClose={() => setDrawerTarget(null)}
          onChanged={() => void load()}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function CreateTeamModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open onClose={onClose} title="New team">
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput
          type="email"
          placeholder="Email (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={saving || !name.trim()}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              const body: Record<string, unknown> = { name };
              if (email.trim()) body.email = email.trim();
              await api.post('/teams', body);
              onCreated();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to create team');
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

type DrawerTab = 'members' | 'roles' | 'preferences';

function TeamDrawer({
  team,
  onClose,
  onChanged,
  canWrite,
}: {
  team: TeamDTO;
  onClose: () => void;
  onChanged: () => void;
  canWrite: boolean;
}): React.ReactElement {
  const [tab, setTab] = useState<DrawerTab>('members');
  const external = Boolean(team.isExternal || team.external);
  const disabled = external || !canWrite;

  return (
    <Drawer open onClose={onClose} title={`Team — ${team.name}`}>
      {external && (
        <div className="mb-4 p-3 rounded-lg bg-surface-high text-xs text-on-surface-variant border border-outline">
          This team is managed via external sync. Edits are disabled.
        </div>
      )}
      <div className="flex gap-1 border-b border-outline mb-4">
        {(['members', 'roles', 'preferences'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'members' && (
        <MembersTab team={team} onChanged={onChanged} disabled={disabled} />
      )}
      {tab === 'roles' && (
        <TeamRolesTab team={team} onChanged={onChanged} disabled={disabled} />
      )}
      {tab === 'preferences' && (
        <TeamPreferencesTab team={team} disabled={disabled} />
      )}
    </Drawer>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function MembersTab({
  team,
  onChanged,
  disabled,
}: {
  team: TeamDTO;
  onChanged: () => void;
  disabled: boolean;
}): React.ReactElement {
  const [members, setMembers] = useState<TeamMemberDTO[]>([]);
  const [candidates, setCandidates] = useState<OrgUserDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, u] = await Promise.all([
        api.get<TeamMemberDTO[] | { members: TeamMemberDTO[] }>(`/teams/${team.id}/members`),
        api.get<PagedResponse<OrgUserDTO> & { users?: OrgUserDTO[] }>(
          usersListUrl('org', { perpage: 200 }),
        ),
      ]);
      const mems = Array.isArray(m) ? m : (m.members ?? []);
      setMembers(mems);
      setCandidates((u.items ?? u.users ?? []).filter(
        (x) => !mems.some((y) => y.userId === x.userId),
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [team.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (userId: string): Promise<void> => {
    try {
      await api.post(`/teams/${team.id}/members`, { userId });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add member');
    }
  };

  const handlePermission = async (member: TeamMemberDTO, permission: number): Promise<void> => {
    try {
      await api.put(`/teams/${team.id}/members/${member.userId}`, { permission });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update permission');
    }
  };

  const handleRemove = async (member: TeamMemberDTO): Promise<void> => {
    try {
      await api.delete(`/teams/${team.id}/members/${member.userId}`);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove');
    }
  };

  return (
    <div>
      <ErrorBanner message={error} />
      {loading ? (
        <LoadingRow />
      ) : (
        <>
          <div className="space-y-2 mb-4">
            {members.map((m) => (
              <div
                key={m.userId}
                className="flex items-center gap-2 p-2 rounded-lg border border-outline"
              >
                <div className="flex-1">
                  <div className="text-sm text-on-surface">{m.name || m.login}</div>
                  <div className="text-xs text-on-surface-variant">{m.email}</div>
                </div>
                {disabled ? (
                  <Badge variant="neutral">{teamPermissionLabel(m.permission)}</Badge>
                ) : (
                  <Select
                    value={String(m.permission)}
                    onChange={(e) => void handlePermission(m, Number(e.target.value))}
                    className="!py-1 !px-2"
                  >
                    <option value="0">Member</option>
                    <option value="4">Admin</option>
                  </Select>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void handleRemove(m)}
                  className="text-xs text-error hover:opacity-80 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
            {members.length === 0 && <EmptyState label="No members yet." />}
          </div>

          {!disabled && candidates.length > 0 && (
            <Select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  void handleAdd(e.target.value);
                  e.target.value = '';
                }
              }}
            >
              <option value="">+ Add member…</option>
              {candidates.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.name || c.login} ({c.email})
                </option>
              ))}
            </Select>
          )}
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function TeamRolesTab({
  team,
  onChanged,
  disabled,
}: {
  team: TeamDTO;
  onChanged: () => void;
  disabled: boolean;
}): React.ReactElement {
  const [assigned, setAssigned] = useState<RoleDTO[]>([]);
  const [available, setAvailable] = useState<RoleDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, all] = await Promise.all([
        api.get<RoleDTO[] | { roles: RoleDTO[] }>(
          `/access-control/teams/${team.id}/roles`,
        ),
        api.get<RoleDTO[] | { roles: RoleDTO[] }>(rolesListUrl(false)),
      ]);
      const assignedList = Array.isArray(a) ? a : (a.roles ?? []);
      const allList = Array.isArray(all) ? all : (all.roles ?? []);
      setAssigned(assignedList);
      setAvailable(allList.filter((r) => !assignedList.some((x) => x.uid === r.uid)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, [team.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAssign = async (roleUid: string): Promise<void> => {
    try {
      await api.post(`/access-control/teams/${team.id}/roles`, { roleUid });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign role');
    }
  };

  const handleUnassign = async (roleUid: string): Promise<void> => {
    try {
      await api.delete(`/access-control/teams/${team.id}/roles/${roleUid}`);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to unassign role');
    }
  };

  return (
    <div>
      <ErrorBanner message={error} />
      {loading ? (
        <LoadingRow />
      ) : (
        <>
          <div className="space-y-2 mb-4">
            {assigned.map((r) => (
              <div
                key={r.uid}
                className="flex items-center gap-2 p-2 rounded-lg border border-outline"
              >
                <div className="flex-1">
                  <div className="text-sm text-on-surface font-mono">{r.name}</div>
                  {r.description && (
                    <div className="text-xs text-on-surface-variant">{r.description}</div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void handleUnassign(r.uid)}
                  className="text-xs text-error hover:opacity-80 disabled:opacity-40"
                >
                  Unassign
                </button>
              </div>
            ))}
            {assigned.length === 0 && <EmptyState label="No roles assigned." />}
          </div>

          {!disabled && available.length > 0 && (
            <Select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  void handleAssign(e.target.value);
                  e.target.value = '';
                }
              }}
            >
              <option value="">+ Assign role…</option>
              {available.map((r) => (
                <option key={r.uid} value={r.uid}>
                  {r.displayName ?? r.name}
                </option>
              ))}
            </Select>
          )}
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

interface TeamPrefsDTO {
  homeDashboardUid?: string | null;
  theme?: string | null;
  timezone?: string | null;
}

function TeamPreferencesTab({
  team,
  disabled,
}: {
  team: TeamDTO;
  disabled: boolean;
}): React.ReactElement {
  const [prefs, setPrefs] = useState<TeamPrefsDTO>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<TeamPrefsDTO>(`/teams/${team.id}/preferences`);
        if (!cancelled) setPrefs(data ?? {});
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load prefs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/teams/${team.id}/preferences`, prefs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save prefs');
    } finally {
      setSaving(false);
    }
  };

  const themes = useMemo(() => ['', 'light', 'dark'], []);

  if (loading) return <LoadingRow />;

  return (
    <div>
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput
          placeholder="Home dashboard UID"
          value={prefs.homeDashboardUid ?? ''}
          disabled={disabled}
          onChange={(e) => setPrefs((p) => ({ ...p, homeDashboardUid: e.target.value || null }))}
        />
        <Select
          value={prefs.theme ?? ''}
          disabled={disabled}
          onChange={(e) => setPrefs((p) => ({ ...p, theme: e.target.value || null }))}
        >
          {themes.map((t) => (
            <option key={t} value={t}>
              {t === '' ? 'Default theme' : t}
            </option>
          ))}
        </Select>
        <TextInput
          placeholder="Timezone (e.g. UTC or browser)"
          value={prefs.timezone ?? ''}
          disabled={disabled}
          onChange={(e) => setPrefs((p) => ({ ...p, timezone: e.target.value || null }))}
        />
      </div>
      <div className="flex justify-end mt-4">
        <PrimaryButton disabled={disabled || saving} onClick={() => void submit()}>
          {saving ? 'Saving…' : 'Save preferences'}
        </PrimaryButton>
      </div>
    </div>
  );
}
