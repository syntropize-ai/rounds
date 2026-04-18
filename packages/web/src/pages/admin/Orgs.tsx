/**
 * T8.6 — Admin / Organizations tab. Server-admin only.
 *
 * Wraps `GET /api/orgs`, `POST /api/orgs`, `PUT /api/orgs/:id`,
 * `DELETE /api/orgs/:id`. Deletion requires typing the org name to confirm —
 * cascades dashboards / investigations / alert rules / teams.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import {
  DangerButton,
  EmptyState,
  ErrorBanner,
  LoadingRow,
  Modal,
  Pager,
  PrimaryButton,
  RowActions,
  SecondaryButton,
  TextInput,
} from './_ui.js';
import { useIsServerAdmin } from './_gate.js';
import { type OrgDTO, type PagedResponse, orgsListUrl } from './_shared.js';

export default function Orgs(): React.ReactElement {
  const isServerAdmin = useIsServerAdmin();

  const [items, setItems] = useState<OrgDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<OrgDTO | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OrgDTO | null>(null);
  const perpage = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = orgsListUrl({ query, page, perpage });
      const data = await api.get<PagedResponse<OrgDTO> & { orgs?: OrgDTO[] }>(url);
      const list = data.items ?? data.orgs ?? [];
      setItems(list);
      setTotal(data.totalCount ?? data.total ?? list.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load organizations');
    } finally {
      setLoading(false);
    }
  }, [query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isServerAdmin) {
    return <EmptyState label="Organizations management is restricted to server admins." />;
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
            placeholder="Search organizations"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            className="flex-1"
          />
          <SecondaryButton type="submit">Search</SecondaryButton>
        </form>
        <PrimaryButton onClick={() => setCreateOpen(true)}>+ New organization</PrimaryButton>
      </div>

      {loading ? (
        <LoadingRow />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-outline">
          <table className="w-full text-sm">
            <thead className="bg-surface-high border-b border-outline">
              <tr>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Name</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Created</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Users</th>
                <th className="text-right px-4 py-3 text-on-surface-variant font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline">
              {items.map((org) => (
                <tr key={org.id}>
                  <td className="px-4 py-2.5 text-on-surface font-medium">{org.name}</td>
                  <td className="px-4 py-2.5 text-on-surface-variant text-xs">
                    {org.created ? new Date(org.created).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-on-surface-variant">{org.userCount ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <RowActions
                      actions={[
                        { label: 'Rename', onSelect: () => setRenameTarget(org) },
                        {
                          label: 'Delete',
                          danger: true,
                          onSelect: () => setDeleteTarget(org),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <EmptyState label="No organizations match your filters." />}
        </div>
      )}

      <Pager page={page} perpage={perpage} total={total} onChange={setPage} />

      {createOpen && (
        <CreateOrgModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      )}
      {renameTarget && (
        <RenameOrgModal
          org={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={() => {
            setRenameTarget(null);
            void load();
          }}
        />
      )}
      {deleteTarget && (
        <DeleteOrgModal
          org={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function CreateOrgModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="New organization">
      <ErrorBanner message={error} />
      <TextInput
        placeholder="Organization name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={!name.trim() || saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.post('/orgs', { name });
              onCreated();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to create organization');
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

function RenameOrgModal({
  org,
  onClose,
  onSaved,
}: {
  org: OrgDTO;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`Rename — ${org.name}`}>
      <ErrorBanner message={error} />
      <TextInput value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={!name.trim() || saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.put(`/orgs/${org.id}`, { name });
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to rename organization');
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

function DeleteOrgModal({
  org,
  onClose,
  onDeleted,
}: {
  org: OrgDTO;
  onClose: () => void;
  onDeleted: () => void;
}): React.ReactElement {
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = confirm === org.name;
  return (
    <Modal open onClose={onClose} title={`Delete ${org.name}`}>
      <ErrorBanner message={error} />
      <div className="text-sm text-on-surface mb-3">
        This removes all dashboards, investigations, alert rules, and teams in this org. Type the
        org name <code className="font-mono text-error">{org.name}</code> to confirm.
      </div>
      <TextInput
        placeholder="Type org name to confirm"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <DangerButton
          disabled={!match || saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.delete(`/orgs/${org.id}`);
              onDeleted();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to delete organization');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Deleting…' : 'Delete organization'}
        </DangerButton>
      </div>
    </Modal>
  );
}
