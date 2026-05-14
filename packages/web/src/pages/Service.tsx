import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../api/client.js';

interface ServiceDetail {
  name: string;
  dashboards: Array<{ id: string; title: string }>;
  alertRules: Array<{ id: string; name: string; state: string; severity: string }>;
  investigations: Array<{ id: string; intent: string; status: string }>;
  owner: string | null;
  deploys: Array<{ version: string; ts: string }>;
}

/**
 * Service detail page (Wave 2 / Step 2). Single API call hydrates all
 * sections; owner/deploys are stubbed null in this PR per scope.
 */
export default function Service() {
  const { name } = useParams<{ name: string }>();
  const [data, setData] = useState<ServiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get<ServiceDetail>(`/services/${encodeURIComponent(name)}`);
        if (!cancelled) setData(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load service');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [name]);

  if (loading) return <div className="p-6">Loading…</div>;
  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!data) return null;

  return (
    <div className="p-6 space-y-6">
      <header>
        <Link to="/services" className="text-sm text-blue-600 hover:underline">← Services</Link>
        <h1 className="text-2xl font-semibold mt-2">{data.name}</h1>
        {data.owner && <div className="text-sm text-gray-600">Owner: {data.owner}</div>}
      </header>

      <section>
        <h2 className="text-lg font-medium mb-2">📊 Dashboards ({data.dashboards.length})</h2>
        {data.dashboards.length === 0 ? (
          <p className="text-sm text-gray-500">No dashboards attributed to this service.</p>
        ) : (
          <ul className="divide-y divide-outline rounded border border-outline">
            {data.dashboards.map((d) => (
              <li key={d.id} className="p-2">
                <Link to={`/dashboards/${d.id}`} className="hover:underline">{d.title}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">🚨 Alerts ({data.alertRules.length})</h2>
        {data.alertRules.length === 0 ? (
          <p className="text-sm text-gray-500">No alerts attributed to this service.</p>
        ) : (
          <ul className="divide-y divide-outline rounded border border-outline">
            {data.alertRules.map((r) => (
              <li key={r.id} className="p-2 flex justify-between">
                <Link to={`/alerts/${r.id}/edit`} className="hover:underline">{r.name}</Link>
                <span className="text-sm text-gray-500">{r.state} · {r.severity}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">🔍 Investigations ({data.investigations.length})</h2>
        {data.investigations.length === 0 ? (
          <p className="text-sm text-gray-500">No investigations attributed to this service.</p>
        ) : (
          <ul className="divide-y divide-outline rounded border border-outline">
            {data.investigations.map((i) => (
              <li key={i.id} className="p-2 flex justify-between">
                <Link to={`/investigations/${i.id}`} className="hover:underline">{i.intent}</Link>
                <span className="text-sm text-gray-500">{i.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">📜 Recent changes</h2>
        {data.deploys.length === 0 ? (
          <p className="text-sm text-gray-500">Deploy timeline will appear once change-event linkage lands.</p>
        ) : (
          <ul>
            {data.deploys.map((d, i) => (
              <li key={i} className="text-sm">{d.version} ({d.ts})</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
