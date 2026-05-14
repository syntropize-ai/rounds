/**
 * Wave 2 / Step 4 — banner shown above the panel grid when a dashboard is
 * opened with `?_inf_<key>=...` URL params the current user hasn't yet
 * acked. See packages/web/src/hooks/useInferredVariables.ts.
 *
 *   ╔════════════════════════════════════════════════════════════════╗
 *   ║ Showing data for                                               ║
 *   ║   service = ingress-gateway   namespace = prod                 ║
 *   ║   (inferred from Service page context)                         ║
 *   ║   [Use these]  [Change variables]  [Don't auto-bind]           ║
 *   ╚════════════════════════════════════════════════════════════════╝
 */

import React from 'react';

interface Props {
  vars: Record<string, string>;
  onAccept: () => void | Promise<void>;
  onChange: () => void;
  onDismiss: () => void;
}

export default function VariableInferenceBanner({ vars, onAccept, onChange, onDismiss }: Props) {
  const entries = Object.entries(vars);
  return (
    <div
      className="shrink-0 px-6 py-3 border-b border-outline-variant bg-primary-container/30 text-on-surface"
      role="region"
      aria-label="Inferred dashboard variables"
    >
      <div className="text-sm font-medium mb-1">Showing data for</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {entries.map(([k, v]) => (
          <span key={k} className="font-mono">
            <span className="text-on-surface-variant">{k}</span>
            <span className="mx-1">=</span>
            <span className="font-semibold">{v}</span>
          </span>
        ))}
      </div>
      <div className="mt-1 text-xs text-on-surface-variant">
        (inferred from Service page context)
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onAccept()}
          className="px-3 py-1.5 text-sm rounded-md bg-primary text-on-primary hover:opacity-90"
        >
          Use these
        </button>
        <button
          type="button"
          onClick={onChange}
          className="px-3 py-1.5 text-sm rounded-md border border-outline-variant hover:bg-surface-low"
        >
          Change variables
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="px-3 py-1.5 text-sm rounded-md hover:bg-surface-low text-on-surface-variant"
        >
          Don't auto-bind
        </button>
      </div>
    </div>
  );
}
