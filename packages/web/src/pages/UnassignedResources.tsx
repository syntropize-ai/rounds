import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../api/client.js';

type ResourceKind = 'dashboard' | 'alert_rule' | 'investigation';

interface UnassignedResource {
  kind: ResourceKind;
  id: string;
  title: string;
}

interface ListResponse {
  resources: UnassignedResource[];
}

/**
 * Unassigned bucket page (Wave 2 / Step 2). Each row has a service-name
 * input + Assign button. Bulk-assign (checkbox selection + single dropdown)
 * is intentionally minimal in this PR; the table layout supports adding it
 * later without restructuring.
 *
 * AI-suggested service name (the spec mentions next-to-each row) is stubbed
 * — Tier 3 AI infer is deferred per the PR scope.
 */
export default function UnassignedResources() {
  const [resources, setResources] = useState<UnassignedResource[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    try {
      const res = await apiClient.get<ListResponse>('/services/unassigned');
      setResources(res.data.resources);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function assign(resource: UnassignedResource): Promise<void> {
    const key = `${resource.kind}::${resource.id}`;
    const serviceName = (drafts[key] ?? '').trim();
    if (!serviceName) return;
    try {
      await apiClient.post(
        `/services/${encodeURIComponent(serviceName)}/assign`,
        { resourceKind: resource.kind, resourceId: resource.id },
      );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'assign failed');
    }
  }

  if (loading) return <div className="p-6">Loading…</div>;
  if (error) return <div className="p-6 text-red-600">{error}</div>;

  return (
    <div className="p-6">
      <Link to="/services" className="text-sm text-blue-600 hover:underline">← Services</Link>
      <h1 className="text-2xl font-semibold mt-2 mb-4">Unassigned resources</h1>

      {resources.length === 0 ? (
        <p className="text-gray-500">All resources have a service. ✨</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-outline">
              <th className="py-2">Kind</th>
              <th>Resource</th>
              <th>Assign to service</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => {
              const key = `${r.kind}::${r.id}`;
              return (
                <tr key={key} className="border-b border-outline">
                  <td className="py-2 pr-3 text-gray-500">{r.kind}</td>
                  <td className="pr-3">{r.title}</td>
                  <td className="pr-3">
                    <input
                      type="text"
                      placeholder="service name"
                      className="border border-outline rounded px-2 py-1 w-64"
                      value={drafts[key] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => void assign(r)}
                      className="px-3 py-1 rounded bg-blue-600 text-white disabled:opacity-50"
                      disabled={!(drafts[key] ?? '').trim()}
                    >
                      Assign
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
