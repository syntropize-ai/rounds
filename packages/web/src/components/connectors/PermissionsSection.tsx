import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ConnectorHumanPolicy,
  type ConnectorPolicy,
  type ConnectorSubjectType,
  type ConnectorType,
  getConnectorTemplate,
  KNOWN_KUBERNETES_CAPABILITIES,
} from '@agentic-obs/common';
import ScopeSelector, { type PermissionScope } from './ScopeSelector.js';
import PermissionsTable from './PermissionsTable.js';
import { defaultPoliciesApi, type PoliciesApi } from './policies-api.js';
import {
  applyOptimistic,
  applyReset,
  buildBatchBodies,
  buildUpsertBody,
} from './permissions-actions.js';

export interface PermissionsSectionProps {
  connectorId: string;
  connectorType: string;
  orgId: string;
  disabled?: boolean;
  /** Override the live api with a recording double — only used in tests. */
  api?: PoliciesApi;
}

const HUMAN_POLICY_OPTIONS: readonly ConnectorHumanPolicy[] = ['allow', 'ask', 'block'];

function capabilitiesFor(type: string): readonly string[] {
  if (type === 'kubernetes') return KNOWN_KUBERNETES_CAPABILITIES;
  try {
    return getConnectorTemplate(type as ConnectorType).capabilities ?? [];
  } catch {
    return [];
  }
}

export function PermissionsSection({
  connectorId,
  connectorType,
  orgId,
  disabled = false,
  api = defaultPoliciesApi,
}: PermissionsSectionProps): React.ReactElement {
  const capabilities = useMemo(() => capabilitiesFor(connectorType), [connectorType]);

  const [scope, setScope] = useState<PermissionScope>({ kind: 'org' });
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [teamsLoading, setTeamsLoading] = useState(true);

  const [orgRows, setOrgRows] = useState<ConnectorPolicy[]>([]);
  const [teamRows, setTeamRows] = useState<ConnectorPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load teams once per connector.
  useEffect(() => {
    let cancelled = false;
    setTeamsLoading(true);
    api
      .listTeams()
      .then((list) => {
        if (!cancelled) setTeams(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load teams');
      })
      .finally(() => {
        if (!cancelled) setTeamsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Always load org rows (needed both for org scope display + team scope inheritance).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .list(connectorId, 'org', orgId)
      .then((rows) => {
        if (!cancelled) setOrgRows(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load policies');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, connectorId, orgId]);

  // Load team rows whenever the selected team changes.
  useEffect(() => {
    if (scope.kind !== 'team') {
      setTeamRows([]);
      return;
    }
    const teamId = scope.teamId;
    let cancelled = false;
    setLoading(true);
    api
      .list(connectorId, 'team', teamId)
      .then((rows) => {
        if (!cancelled) setTeamRows(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load policies');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, connectorId, scope]);

  const subjectType: ConnectorSubjectType = scope.kind === 'team' ? 'team' : 'org';
  const subjectId = scope.kind === 'team' ? scope.teamId : orgId;
  const visibleRows = scope.kind === 'team' ? teamRows : orgRows;

  const ctx = { connectorId, subjectType, subjectId };

  const writeVisible = (rows: ConnectorPolicy[]) => {
    if (scope.kind === 'team') setTeamRows(rows);
    else setOrgRows(rows);
  };

  const handleSet = useCallback(
    async (capability: string, next: ConnectorHumanPolicy) => {
      if (disabled || busy) return;
      const previous = visibleRows;
      const optimistic = applyOptimistic(visibleRows, ctx, capability, next);
      writeVisible(optimistic);
      setBusy(true);
      setError(null);
      try {
        await api.upsert(connectorId, buildUpsertBody(ctx, capability, next));
      } catch (err) {
        writeVisible(previous);
        setError(err instanceof Error ? err.message : 'Failed to save policy');
      } finally {
        setBusy(false);
      }
    },
    [api, busy, connectorId, disabled, subjectId, subjectType, visibleRows],
  );

  const handleReset = useCallback(
    async (capability: string) => {
      if (disabled || busy) return;
      if (scope.kind !== 'team') return;
      const previous = teamRows;
      const optimistic = applyReset(teamRows, capability);
      setTeamRows(optimistic);
      setBusy(true);
      setError(null);
      try {
        await api.remove(connectorId, 'team', scope.teamId, capability);
      } catch (err) {
        setTeamRows(previous);
        setError(err instanceof Error ? err.message : 'Failed to reset policy');
      } finally {
        setBusy(false);
      }
    },
    [api, busy, connectorId, disabled, scope, teamRows],
  );

  const handleBatch = useCallback(
    async (next: ConnectorHumanPolicy) => {
      if (disabled || busy || capabilities.length === 0) return;
      const bodies = buildBatchBodies(ctx, capabilities, next);
      const optimistic: ConnectorPolicy[] = bodies.map((b) => ({
        connectorId,
        subjectType: b.subjectType,
        subjectId: b.subjectId,
        capability: b.capability,
        scope: null,
        humanPolicy: b.humanPolicy,
      }));
      writeVisible(optimistic);
      setBusy(true);
      setError(null);
      const results = await Promise.allSettled(
        bodies.map((body) => api.upsert(connectorId, body)),
      );
      const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      if (failures.length > 0) {
        const reason = failures[0]!.reason;
        setError(reason instanceof Error ? reason.message : 'Failed to apply batch policy');
        // Server may be partially updated — refetch to reflect server truth.
        try {
          const rows = await api.list(connectorId, subjectType, subjectId);
          writeVisible(rows);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to refresh policies');
        }
      }
      setBusy(false);
    },
    [api, busy, capabilities, connectorId, disabled, subjectId, subjectType, visibleRows],
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-on-surface)]">Permissions</h3>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScopeSelector
          scope={scope}
          onChange={setScope}
          teams={teams}
          teamsLoading={teamsLoading}
          disabled={disabled || busy}
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--color-on-surface-variant)]" htmlFor="connector-batch-policy">
            Apply to all
          </label>
          <select
            id="connector-batch-policy"
            disabled={disabled || busy || capabilities.length === 0}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value as ConnectorHumanPolicy | '';
              if (!v) return;
              void handleBatch(v);
              e.target.value = '';
            }}
            className="rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] px-2 py-1 text-sm text-[var(--color-on-surface)]"
          >
            <option value="" disabled>
              Choose…
            </option>
            {HUMAN_POLICY_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[var(--color-on-surface-variant)]">Loading policies…</p>
      ) : (
        <PermissionsTable
          capabilities={capabilities}
          scopeRows={visibleRows}
          orgRows={orgRows}
          scope={subjectType}
          disabled={disabled || busy}
          onSet={(cap, next) => void handleSet(cap, next)}
          onReset={scope.kind === 'team' ? (cap) => void handleReset(cap) : undefined}
        />
      )}
    </section>
  );
}

export default PermissionsSection;
