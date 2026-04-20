/**
 * `/admin/orgs/:id` — server-admin drill-down into a single organization.
 *
 * Grafana-parity with `/org/orgs/edit/:id` — lets a Server Admin manage an
 * org's members without switching their active org via the OrgSwitcher.
 * Scope is the specific org in the URL; the admin's current org context is
 * irrelevant here.
 *
 * Data sources (all already exist on the server — see
 * docs/auth-perm-design/08-api-surface.md §/api/orgs):
 *   - `GET    /api/orgs/:id`                      — org header (name)
 *   - `PATCH  /api/orgs/:id`                      — inline rename
 *   - `GET    /api/orgs/:id/users`                — list members (paged)
 *   - `POST   /api/orgs/:id/users`                — add member by login/email
 *   - `PATCH  /api/orgs/:id/users/:userId`        — change role
 *   - `DELETE /api/orgs/:id/users/:userId`        — remove member
 *
 * T4 decision — we copy the ~100 LOC members table rather than refactor a
 * `UsersTable` out of `Users.tsx`: the admin surface there has disable /
 * reset-password / revoke-sessions actions that don't apply cross-org, and
 * the `mode === 'admin' | 'org'` toggle is already a hump to wedge a third
 * mode into. Third copy is the natural refactor trigger.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import {
  Badge,
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
import { useIsServerAdmin } from './_gate.js';
import { RenameOrgModal } from './RenameOrgModal.js';
import {
  type OrgDTO,
  type OrgUserDTO,
  type PagedResponse,
  authMethodLabel,
} from './_shared.js';

const ORG_ROLES = ['Admin', 'Editor', 'Viewer', 'None'] as const;

export default function OrgUsers(): React.ReactElement {
  const isServerAdmin = useIsServerAdmin();
  const params = useParams<{ id: string }>();
  const orgId = params.id ?? '';

  const [org, setOrg] = useState<OrgDTO | null>(null);
  const [rows, setRows] = useState<OrgUserDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perpage] = useState(20);
  const [query, setQuery] = useState('');
  const [queryInput, setQueryInput] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  const loadOrg = useCallback(async (): Promise<void> => {
    try {
      const data = await api.get<OrgDTO>(`/orgs/${orgId}`);
      setOrg(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load organization');
    }
  }, [orgId]);

  const loadMembers = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (query) qs.set('query', query);
      qs.set('page', String(page));
      qs.set('perpage', String(perpage));
      const data = await api.get<PagedResponse<OrgUserDTO>>(
        `/orgs/${orgId}/users?${qs.toString()}`,
      );
      const items = data.items ?? [];
      setRows(items);
      setTotal(data.totalCount ?? data.total ?? items.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [orgId, query, page, perpage]);

  useEffect(() => {
    if (!isServerAdmin || !orgId) return;
    void loadOrg();
  }, [isServerAdmin, orgId, loadOrg]);

  useEffect(() => {
    if (!isServerAdmin || !orgId) return;
    void loadMembers();
  }, [isServerAdmin, orgId, loadMembers]);

  // Gate AFTER all hooks so we don't violate the rules of hooks when the
  // server-admin claim arrives asynchronously on first render.
  if (!isServerAdmin) {
    return <Navigate to="/admin" replace />;
  }

  const handleChangeRole = async (u: OrgUserDTO, role: string): Promise<void> => {
    try {
      await api.patch(`/orgs/${orgId}/users/${u.userId}`, { role });
      await loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change role');
    }
  };

  const handleRemove = async (u: OrgUserDTO): Promise<void> => {
    if (!window.confirm(`Remove ${u.login} from ${org?.name ?? 'this organization'}?`)) return;
    try {
      await api.delete(`/orgs/${orgId}/users/${u.userId}`);
      await loadMembers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member');
    }
  };

  return (
    <div>
      <div className="mb-4">
        <Link
          to="/admin/orgs"
          className="text-sm text-primary hover:underline inline-flex items-center gap-1"
        >
          ← Back to organizations
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-on-surface">
            {org?.name ?? 'Organization'}
          </h2>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Manage members of this organization. Changes apply regardless of your
            currently selected org.
          </p>
        </div>
        <SecondaryButton
          disabled={!org}
          onClick={() => setRenameOpen(true)}
        >
          Rename organization
        </SecondaryButton>
      </div>

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
            placeholder="Search members by login, email or name"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            className="flex-1"
          />
          <SecondaryButton type="submit">Search</SecondaryButton>
        </form>
        <PrimaryButton onClick={() => setAddOpen(true)}>+ Add user</PrimaryButton>
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
                <th className="text-right px-4 py-3 text-on-surface-variant font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline">
              {rows.map((u) => (
                <tr key={u.userId}>
                  <td className="px-4 py-2.5 text-on-surface font-medium">{u.login}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge>{authMethodLabel(u.authLabels)}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {(ORG_ROLES as readonly string[]).includes(u.role) ? (
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
                  <td className="px-4 py-2.5 text-right">
                    <RowActions
                      actions={[
                        {
                          label: 'Remove from organization',
                          danger: true,
                          onSelect: () => void handleRemove(u),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <EmptyState label="No members match your filters." />}
        </div>
      )}

      <Pager page={page} perpage={perpage} total={total} onChange={setPage} />

      {addOpen && (
        <AddMemberModal
          orgId={orgId}
          onClose={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void loadMembers();
          }}
        />
      )}
      {renameOpen && org && (
        <RenameOrgModal
          org={org}
          onClose={() => setRenameOpen(false)}
          onSaved={() => {
            setRenameOpen(false);
            void loadOrg();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function AddMemberModal({
  orgId,
  onClose,
  onAdded,
}: {
  orgId: string;
  onClose: () => void;
  onAdded: () => void;
}): React.ReactElement {
  const [loginOrEmail, setLoginOrEmail] = useState('');
  const [role, setRole] = useState<(typeof ORG_ROLES)[number]>('Viewer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open onClose={onClose} title="Add user to organization">
      <ErrorBanner message={error} />
      <div className="grid grid-cols-1 gap-3">
        <TextInput
          placeholder="Login or email"
          value={loginOrEmail}
          onChange={(e) => setLoginOrEmail(e.target.value)}
        />
        <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
          {ORG_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={!loginOrEmail.trim() || saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.post(`/orgs/${orgId}/users`, { loginOrEmail, role });
              onAdded();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to add user');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Adding…' : 'Add user'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

