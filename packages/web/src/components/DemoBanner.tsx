// DemoBanner — visible only when the api-gateway reports OPENOBS_DEMO=1.
//
// Probes `GET /api/demo/status` once on mount. The endpoint is unmounted
// in normal mode (404), so a missing response keeps the banner hidden;
// no env-var sneaks in via the client.

import React, { useEffect, useState } from 'react';

interface DemoStatus {
  enabled: true;
  banner: string;
  cta: { label: string; investigationId: string };
}

export default function DemoBanner() {
  const [status, setStatus] = useState<DemoStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/demo/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DemoStatus | null) => {
        if (!cancelled && data?.enabled) setStatus(data);
      })
      .catch(() => { /* normal mode — endpoint not mounted */ });
    return () => { cancelled = true; };
  }, []);

  if (!status) return null;

  return (
    <div
      data-testid="demo-banner"
      className="flex items-center justify-between gap-4 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:border-amber-600 dark:bg-amber-900/40 dark:text-amber-100"
    >
      <span>
        <strong className="mr-2">DEMO MODE</strong>
        {status.banner}
      </span>
      <a
        href={`/investigations/${status.cta.investigationId}`}
        className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
      >
        {status.cta.label}
      </a>
    </div>
  );
}
