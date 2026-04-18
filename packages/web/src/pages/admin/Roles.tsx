/**
 * T8.5 — Admin / Roles tab.
 *
 * Three sub-tabs grouping roles by origin: built-in (`basic:*`, read-only),
 * fixed (`fixed:*`, read-only) and custom (`custom:*`, editable with
 * `roles:write`). See docs/auth-perm-design/03-rbac-model.md §built-in +
 * §fixed + §custom roles.
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
  PrimaryButton,
  RowActions,
  SecondaryButton,
  TextInput,
} from './_ui.js';
import { useHasPermission, useIsServerAdmin } from './_gate.js';
import {
  type RoleDTO,
  classifyRole,
  isValidCustomRoleName,
  rolesListUrl,
} from './_shared.js';

type Bucket = 'built-in' | 'fixed' | 'custom';

export default function Roles(): React.ReactElement {
  const has = useHasPermission();
  const isServerAdmin = useIsServerAdmin();
  const canRead = has('roles:read') || isServerAdmin;
  const canWrite = has('roles:write') || isServerAdmin;

  const [roles, setRoles] = useState<RoleDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>('built-in');
  const [drawerTarget, setDrawerTarget] = useState<RoleDTO | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<RoleDTO[] | { roles: RoleDTO[] }>(rolesListUrl(true));
      setRoles(Array.isArray(data) ? data : (data.roles ?? []));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => roles.filter((r) => classifyRole(r.uid) === bucket),
    [roles, bucket],
  );

  const handleDelete = async (r: RoleDTO): Promise<void> => {
    if (!window.confirm(`Delete role ${r.name}?`)) return;
    try {
      await api.delete(`/access-control/roles/${r.uid}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete role');
    }
  };

  if (!canRead) {
    return <EmptyState label="You don't have permission to view roles." />;
  }

  return (
    <div>
      <ErrorBanner message={error} />

      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 border-b border-outline">
          {(['built-in', 'fixed', 'custom'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBucket(b)}
              className={`px-4 py-2 text-sm border-b-2 -mb-px ${
                bucket === b
                  ? 'border-primary text-primary'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {b[0]!.toUpperCase() + b.slice(1)}
            </button>
          ))}
        </div>
        {bucket === 'custom' && canWrite && (
          <PrimaryButton onClick={() => setCreateOpen(true)}>+ New custom role</PrimaryButton>
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
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">
                  Display name
                </th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">
                  Description
                </th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Group</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Version</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">
                  Assigned
                </th>
                <th className="text-right px-4 py-3 text-on-surface-variant font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline">
              {filtered.map((r) => (
                <tr
                  key={r.uid}
                  onClick={() => setDrawerTarget(r)}
                  className="cursor-pointer hover:bg-surface-high/50"
                >
                  <td className="px-4 py-2.5 text-on-surface font-mono text-xs">{r.name}</td>
                  <td className="px-4 py-2.5 text-on-surface">{r.displayName ?? '—'}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant text-xs">
                    {r.description ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.group ? <Badge>{r.group}</Badge> : <span className="text-on-surface-variant text-xs">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-on-surface-variant text-xs">{r.version ?? '—'}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant">{r.assignments ?? '—'}</td>
                  <td
                    className="px-4 py-2.5 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {bucket === 'custom' && canWrite ? (
                      <RowActions
                        actions={[
                          { label: 'View', onSelect: () => setDrawerTarget(r) },
                          {
                            label: 'Delete',
                            danger: true,
                            onSelect: () => void handleDelete(r),
                          },
                        ]}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDrawerTarget(r)}
                        className="text-xs text-on-surface-variant hover:text-on-surface"
                      >
                        View
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <EmptyState label={`No ${bucket} roles.`} />}
        </div>
      )}

      {createOpen && (
        <CreateCustomRoleModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setBucket('custom');
            void load();
          }}
        />
      )}

      {drawerTarget && (
        <RoleDrawer
          role={drawerTarget}
          onClose={() => setDrawerTarget(null)}
          onChanged={() => void load()}
          canWrite={canWrite && classifyRole(drawerTarget.uid) === 'custom'}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function CreateCustomRoleModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const [name, setName] = useState('custom:');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [group, setGroup] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = isValidCustomRoleName(name);

  return (
    <Modal open onClose={onClose} title="Create custom role">
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput
          placeholder="custom:<role-name>"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {!canSubmit && (
          <div className="text-xs text-on-surface-variant">
            Name must start with <code>custom:</code> and contain at least one more character.
          </div>
        )}
        <TextInput
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <TextInput
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextInput placeholder="Group" value={group} onChange={(e) => setGroup(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={!canSubmit || saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.post('/access-control/roles', {
                name,
                displayName,
                description,
                group,
                version: 1,
                permissions: [],
              });
              onCreated();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to create role');
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

type RoleDrawerTab = 'overview' | 'permissions' | 'usedby';

function RoleDrawer({
  role,
  onClose,
  onChanged,
  canWrite,
}: {
  role: RoleDTO;
  onClose: () => void;
  onChanged: () => void;
  canWrite: boolean;
}): React.ReactElement {
  const [tab, setTab] = useState<RoleDrawerTab>('overview');
  return (
    <Drawer open onClose={onClose} title={`Role — ${role.name}`}>
      <div className="flex gap-1 border-b border-outline mb-4">
        {(['overview', 'permissions', 'usedby'] as const).map((t) => (
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
            {t === 'usedby' ? 'Used by' : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && <RoleOverview role={role} />}
      {tab === 'permissions' && (
        <RolePermissions role={role} canWrite={canWrite} onChanged={onChanged} />
      )}
      {tab === 'usedby' && <RoleUsedBy role={role} />}
    </Drawer>
  );
}

function RoleOverview({ role }: { role: RoleDTO }): React.ReactElement {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-xs text-on-surface-variant">Name</div>
        <div className="font-mono text-on-surface">{role.name}</div>
      </div>
      {role.displayName && (
        <div>
          <div className="text-xs text-on-surface-variant">Display name</div>
          <div className="text-on-surface">{role.displayName}</div>
        </div>
      )}
      {role.description && (
        <div>
          <div className="text-xs text-on-surface-variant">Description</div>
          <div className="text-on-surface">{role.description}</div>
        </div>
      )}
      {role.group && (
        <div>
          <div className="text-xs text-on-surface-variant">Group</div>
          <div className="text-on-surface">{role.group}</div>
        </div>
      )}
      <div>
        <div className="text-xs text-on-surface-variant">Version</div>
        <div className="text-on-surface">{role.version ?? '—'}</div>
      </div>
    </div>
  );
}

function RolePermissions({
  role,
  canWrite,
  onChanged,
}: {
  role: RoleDTO;
  canWrite: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const [perms, setPerms] = useState<Array<{ action: string; scope?: string }>>(
    role.permissions ?? [],
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newAction, setNewAction] = useState('');
  const [newScope, setNewScope] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await api.get<RoleDTO>(`/access-control/roles/${role.uid}`);
        if (!cancelled) setPerms(fresh.permissions ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [role.uid]);

  const save = async (next: Array<{ action: string; scope?: string }>): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/access-control/roles/${role.uid}`, {
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        group: role.group,
        version: role.version,
        permissions: next,
      });
      setPerms(next);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save permissions');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingRow />;
  return (
    <div>
      <ErrorBanner message={error} />
      <div className="space-y-2 mb-4">
        {perms.map((p, idx) => (
          <div
            key={`${p.action}::${p.scope ?? ''}::${idx}`}
            className="flex items-center gap-2 p-2 rounded-lg border border-outline"
          >
            <div className="flex-1">
              <div className="text-sm font-mono text-on-surface">{p.action}</div>
              <div className="text-xs text-on-surface-variant">{p.scope || '(unrestricted)'}</div>
            </div>
            {canWrite && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(perms.filter((_, i) => i !== idx))}
                className="text-xs text-error hover:opacity-80 disabled:opacity-40"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {perms.length === 0 && <EmptyState label="No permissions." />}
      </div>

      {canWrite && (
        <div className="border-t border-outline pt-3">
          <div className="text-xs text-on-surface-variant mb-2">Add permission</div>
          <div className="grid grid-cols-2 gap-2">
            <TextInput
              placeholder="action (e.g. dashboards:read)"
              value={newAction}
              onChange={(e) => setNewAction(e.target.value)}
            />
            <TextInput
              placeholder="scope (optional)"
              value={newScope}
              onChange={(e) => setNewScope(e.target.value)}
            />
          </div>
          <div className="flex justify-end mt-2">
            <PrimaryButton
              disabled={!newAction.trim() || saving}
              onClick={() => {
                const entry: { action: string; scope?: string } = { action: newAction.trim() };
                if (newScope.trim()) entry.scope = newScope.trim();
                void save([...perms, entry]).then(() => {
                  setNewAction('');
                  setNewScope('');
                });
              }}
            >
              {saving ? 'Saving…' : 'Add'}
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

function RoleUsedBy({ role }: { role: RoleDTO }): React.ReactElement {
  interface Assignment {
    principalType: 'user' | 'team';
    principalId: string;
    login?: string;
    email?: string;
    name?: string;
  }
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<Assignment[] | { assignments: Assignment[] }>(
          `/access-control/roles/${role.uid}/assignments`,
        );
        if (!cancelled) {
          setAssignments(Array.isArray(data) ? data : (data.assignments ?? []));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load assignments');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [role.uid]);

  if (loading) return <LoadingRow />;
  return (
    <div>
      <ErrorBanner message={error} />
      {assignments.length === 0 ? (
        <EmptyState label="No users or teams have this role." />
      ) : (
        <div className="space-y-1">
          {assignments.map((a) => (
            <div
              key={`${a.principalType}-${a.principalId}`}
              className="flex items-center gap-2 p-2 rounded-lg border border-outline"
            >
              <Badge variant={a.principalType === 'user' ? 'primary' : 'success'}>
                {a.principalType}
              </Badge>
              <div className="flex-1 text-sm text-on-surface">
                {a.name ?? a.login ?? a.principalId}
              </div>
              {a.email && <div className="text-xs text-on-surface-variant">{a.email}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
