/**
 * T8.3 — Admin / Audit Log tab.
 *
 * Displays `GET /api/admin/audit-log` paged and filterable. Row click opens
 * a drawer with the full metadata JSON. Matches docs/auth-perm-design/09-frontend.md §T8.3.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import {
  Drawer,
  EmptyState,
  ErrorBanner,
  LoadingRow,
  Pager,
  SecondaryButton,
  Select,
  TextInput,
} from './_ui.js';
import { useHasPermission, useIsServerAdmin } from './_gate.js';
import {
  type AuditLogEntryDTO,
  type PagedResponse,
  auditLogUrl,
} from './_shared.js';

const ACTIONS = [
  { value: '', label: 'All actions' },
  { value: 'user.login', label: 'user.login' },
  { value: 'user.login_failed', label: 'user.login_failed' },
  { value: 'user.logout', label: 'user.logout' },
  { value: 'user.create', label: 'user.create' },
  { value: 'user.delete', label: 'user.delete' },
  { value: 'role.assign', label: 'role.assign' },
  { value: 'role.revoke', label: 'role.revoke' },
  { value: 'team.create', label: 'team.create' },
  { value: 'team.delete', label: 'team.delete' },
];

const OUTCOMES = [
  { value: '', label: 'Any outcome' },
  { value: 'success', label: 'success' },
  { value: 'failure', label: 'failure' },
];

export default function AuditLog(): React.ReactElement {
  const has = useHasPermission();
  const isServerAdmin = useIsServerAdmin();
  const canView = has('server.audit:read') || isServerAdmin;

  const [items, setItems] = useState<AuditLogEntryDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [drawerTarget, setDrawerTarget] = useState<AuditLogEntryDTO | null>(null);

  const perpage = 50;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = auditLogUrl({
        action: action || undefined,
        actorId: actor || undefined,
        outcome: outcome || undefined,
        from: from || undefined,
        to: to || undefined,
        page,
        perpage,
      });
      const data = await api.get<
        PagedResponse<AuditLogEntryDTO> & { entries?: AuditLogEntryDTO[] }
      >(url);
      const list = data.items ?? data.entries ?? [];
      setItems(list);
      setTotal(data.totalCount ?? data.total ?? list.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [action, actor, outcome, from, to, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canView) {
    return <EmptyState label="You don't have permission to view the audit log." />;
  }

  return (
    <div>
      <ErrorBanner message={error} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 mb-4">
        <Select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
        >
          {ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </Select>
        <TextInput
          placeholder="Actor ID or login"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <Select
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value);
            setPage(1);
          }}
        >
          {OUTCOMES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <TextInput
          type="date"
          placeholder="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextInput
          type="date"
          placeholder="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>

      <div className="flex justify-end mb-3">
        <SecondaryButton
          onClick={() => {
            setPage(1);
            void load();
          }}
        >
          Apply filters
        </SecondaryButton>
      </div>

      {loading ? (
        <LoadingRow />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-outline">
          <table className="w-full text-sm">
            <thead className="bg-surface-high border-b border-outline">
              <tr>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Time</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Actor</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Action</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Target</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">Outcome</th>
                <th className="text-left px-4 py-3 text-on-surface-variant font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline">
              {items.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setDrawerTarget(e)}
                  className="cursor-pointer hover:bg-surface-high/50"
                >
                  <td className="px-4 py-2 text-on-surface-variant text-xs whitespace-nowrap">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-on-surface text-xs">
                    {e.actorLogin ?? e.actorId ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-on-surface text-xs font-mono">{e.action}</td>
                  <td className="px-4 py-2 text-on-surface-variant text-xs">
                    {e.targetLogin ?? e.targetId ?? '—'}
                  </td>
                  <td
                    className={`px-4 py-2 text-xs ${
                      e.outcome === 'success' ? 'text-tertiary' : 'text-error'
                    }`}
                  >
                    {e.outcome}
                  </td>
                  <td className="px-4 py-2 text-on-surface-variant text-xs">{e.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <EmptyState label="No audit entries match your filters." />}
        </div>
      )}

      <Pager page={page} perpage={perpage} total={total} onChange={setPage} />

      {drawerTarget && (
        <Drawer open onClose={() => setDrawerTarget(null)} title="Audit event">
          <div className="space-y-3 text-sm">
            <Field label="Time" value={new Date(drawerTarget.timestamp).toLocaleString()} />
            <Field label="Action" value={drawerTarget.action} mono />
            <Field label="Actor" value={drawerTarget.actorLogin ?? drawerTarget.actorId ?? '—'} />
            <Field label="Target" value={drawerTarget.targetLogin ?? drawerTarget.targetId ?? '—'} />
            <Field label="Outcome" value={drawerTarget.outcome} />
            <Field label="IP" value={drawerTarget.ip ?? '—'} />
            <Field label="User agent" value={drawerTarget.userAgent ?? '—'} />
            <div>
              <div className="text-xs text-on-surface-variant mb-1">Metadata</div>
              <pre className="bg-surface-highest rounded-lg p-3 text-xs overflow-x-auto text-on-surface">
                {JSON.stringify(drawerTarget.metadata ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div>
      <div className="text-xs text-on-surface-variant">{label}</div>
      <div className={`text-sm text-on-surface ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
