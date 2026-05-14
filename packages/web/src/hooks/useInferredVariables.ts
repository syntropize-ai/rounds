/**
 * Wave 2 / Step 4 — dashboard variable inference confirm.
 *
 * Reads `?_inf_<key>=<value>` query params from the URL. If any are present
 * and the user hasn't yet acked this exact variable set for this dashboard,
 * the hook reports `state: 'needs-ack'` and the workspace renders the
 * VariableInferenceBanner. The user can then:
 *   - "Use these": POST the ack, hook flips to 'applied', vars are bound.
 *   - "Change variables": parent opens the existing variable picker.
 *   - "Don't auto-bind": session-only dismiss; nothing persisted.
 *
 * If the URL params change (e.g. user navigates from a different service
 * context) the hash changes and the banner re-appears even if previously
 * acked. This is the whole point — wrong-namespace data is high stakes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { hashVariables } from '@agentic-obs/common';
import { apiClient } from '../api/client.js';

const INF_PREFIX = '_inf_';

export type InferredState =
  | { kind: 'none' }
  | { kind: 'checking'; vars: Record<string, string>; hash: string }
  | { kind: 'needs-ack'; vars: Record<string, string>; hash: string }
  | { kind: 'applied'; vars: Record<string, string>; hash: string }
  | { kind: 'dismissed'; vars: Record<string, string>; hash: string };

export interface UseInferredVariablesResult {
  state: InferredState;
  /** Persist the ack and transition to 'applied'. */
  accept: () => Promise<void>;
  /** Session-only dismiss — does not persist. Banner stays hidden this page load only. */
  dismiss: () => void;
}

/**
 * Parse `?_inf_<k>=<v>` params out of a query string. Keys with empty
 * values are dropped (matches the hash semantics — see variable-hash.ts).
 *
 * Edge case: if the same `_inf_` key appears twice we take the *first*
 * value. `URLSearchParams.get` already does this; the explicit comment
 * is for the next reader.
 */
export function parseInferredFromSearch(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    if (!k.startsWith(INF_PREFIX)) continue;
    if (v === '') continue;
    const stripped = k.slice(INF_PREFIX.length);
    if (stripped in out) continue;
    out[stripped] = v;
  }
  return out;
}

export function useInferredVariables(dashboardUid: string | undefined): UseInferredVariablesResult {
  const location = useLocation();
  const vars = useMemo(() => parseInferredFromSearch(location.search), [location.search]);
  const hasVars = Object.keys(vars).length > 0;
  const hash = useMemo(() => (hasVars ? hashVariables(vars) : ''), [vars, hasVars]);

  const [state, setState] = useState<InferredState>(() =>
    hasVars ? { kind: 'checking', vars, hash } : { kind: 'none' },
  );

  // Reset state when URL hash changes — different service context, new ack.
  useEffect(() => {
    if (!hasVars) {
      setState({ kind: 'none' });
      return;
    }
    setState({ kind: 'checking', vars, hash });
  }, [hash, hasVars, vars]);

  // Fetch the ack status.
  useEffect(() => {
    if (!hasVars || !dashboardUid) return;
    let cancelled = false;
    void apiClient
      .get<{ acked: boolean }>(`/dashboards/${dashboardUid}/variable-ack?vars=${hash}`)
      .then((res) => {
        if (cancelled) return;
        if (res.error || !res.data) {
          // If we can't check, fall back to showing the banner. Better to
          // ask the user than silently bind possibly-wrong variables.
          setState({ kind: 'needs-ack', vars, hash });
          return;
        }
        setState(
          res.data.acked
            ? { kind: 'applied', vars, hash }
            : { kind: 'needs-ack', vars, hash },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [hash, hasVars, dashboardUid, vars]);

  const accept = useCallback(async () => {
    if (!dashboardUid || !hasVars) return;
    await apiClient.post(`/dashboards/${dashboardUid}/variable-ack`, { vars });
    setState({ kind: 'applied', vars, hash });
  }, [dashboardUid, hasVars, vars, hash]);

  const dismiss = useCallback(() => {
    if (!hasVars) return;
    setState({ kind: 'dismissed', vars, hash });
  }, [hasVars, vars, hash]);

  return { state, accept, dismiss };
}
