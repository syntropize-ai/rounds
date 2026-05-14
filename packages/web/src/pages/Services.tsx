import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../api/client.js';

interface ServiceSummary {
  name: string;
  resourceCount: number;
}

interface ServicesResponse {
  services: ServiceSummary[];
  unassignedCount: number;
}

/**
 * Services list page (Wave 2 / Step 2).
 *
 * "Services" is the primary organizing concept — sorted by resource count
 * desc. Resources without a high-confidence attribution surface in the
 * Unassigned banner at the top of the list.
 */
export default function Services() {
  const [data, setData] = useState<ServicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get<ServicesResponse>('/services');
        if (!cancelled) setData(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load services');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="p-6">Loading…</div>;
  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!data) return null;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Services</h1>

      {data.unassignedCount > 0 && (
        <div className="mb-4 p-3 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-between">
          <span>
            <span className="font-medium">⚠ {data.unassignedCount}</span> resources not attributed
          </span>
          <Link
            to="/services/unassigned"
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            Assign in bulk →
          </Link>
        </div>
      )}

      {data.services.length === 0 ? (
        <div className="text-gray-500">No services yet. Resources with a <code>service=</code> Prometheus label will appear here automatically.</div>
      ) : (
        <ul className="divide-y divide-outline rounded border border-outline">
          {data.services.map((s) => (
            <li key={s.name} className="p-3 hover:bg-surface-variant">
              <Link to={`/services/${encodeURIComponent(s.name)}`} className="block">
                <div className="font-medium">{s.name}</div>
                <div className="text-sm text-gray-500">{s.resourceCount} resources</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
