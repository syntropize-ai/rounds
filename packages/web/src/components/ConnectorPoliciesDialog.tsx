import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  getConnectorTemplate,
  KNOWN_KUBERNETES_CAPABILITIES,
  KUBERNETES_DEFAULT_POLICIES,
  type ConnectorAgentPolicy,
  type ConnectorHumanPolicy,
  type ConnectorPolicyScope,
  type ConnectorTeamPolicy,
  type ConnectorType,
} from '@agentic-obs/common';
import { apiClient } from '../api/client.js';
import ConfirmDialog from './ConfirmDialog.js';

/**
 * Per-connector policy management dialog. Wired from Settings → Connectors
 * tab. Lists existing `ConnectorTeamPolicy` rows for the connector, lets the
 * user upsert/delete grants per (team, capability) pair, and mutates the
 * backend via:
 *
 *   GET    /api/connectors/:id/policies
 *   PUT    /api/connectors/:id/policies      (upsert: { teamId, capability, humanPolicy, agentPolicy, scope? })
 *   DELETE /api/connectors/:id/policies/:teamId/:capability
 *
 * Updates are optimistic with rollback on API failure (banner at top). Delete
 * goes through the existing `<ConfirmDialog>` so the user can't fat-finger it.
 */

export interface ConnectorPoliciesDialogConnector {
  id: string;
  name: string;
  type: string;
}

export interface PoliciesApi {
  list(connectorId: string): Promise<ConnectorTeamPolicy[]>;
  listTeams(): Promise<Array<{ id: string; name: string }>>;
  upsert(connectorId: string, body: UpsertBody): Promise<ConnectorTeamPolicy>;
  remove(connectorId: string, teamId: string, capability: string): Promise<void>;
}

export interface UpsertBody {
  teamId: string;
  capability: string;
  humanPolicy: ConnectorHumanPolicy;
  agentPolicy: ConnectorAgentPolicy;
  scope?: ConnectorPolicyScope | null;
}

export interface ConnectorPoliciesDialogProps {
  connector: ConnectorPoliciesDialogConnector;
  onClose: () => void;
  /** Optional override — primarily for tests. */
  api?: PoliciesApi;
}

export const HUMAN_POLICY_OPTIONS: ConnectorHumanPolicy[] = [
  'allow',
  'confirm',
  'strong_confirm',
  'deny',
];

export const AGENT_POLICY_OPTIONS: ConnectorAgentPolicy[] = [
  'allow',
  'suggest',
  'formal_approval',
  'deny',
];

/**
 * Capability strings have the shape `<area>.<verb>` — lowercase letters,
 * digits, and underscores only, with exactly one dot. The Policies dialog
 * accepts free-text input so admins can author policies for any capability
 * the runtime emits; this regex is the only structural gate.
 */
export const CAPABILITY_REGEX = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function isValidCapability(s: string): boolean {
  return CAPABILITY_REGEX.test(s);
}

/**
 * Pure helper. Parses the optional scope JSON string from the "Add policy"
 * form. Empty string → null. Returns `{ ok: false }` if non-empty input is
 * not a JSON object so the caller can surface a validation error.
 */
export function parseScope(
  raw: string,
): { ok: true; value: ConnectorPolicyScope | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Scope must be a JSON object' };
    }
    return { ok: true, value: parsed as ConnectorPolicyScope };
  } catch {
    return { ok: false, message: 'Scope must be valid JSON' };
  }
}

/**
 * Pure predicate. The "+ Add" button is disabled until every required field
 * is set; scope is optional but, if present, must parse. An empty `teamId`
 * is **allowed** — it represents the wildcard ("All teams") rule the
 * backend uses as a connector-wide default.
 */
export function canSubmitAdd(args: {
  teamId: string;
  capability: string;
  humanPolicy: string;
  agentPolicy: string;
  scopeRaw: string;
}): boolean {
  if (!args.capability) return false;
  if (!isValidCapability(args.capability)) return false;
  if (!args.humanPolicy || !args.agentPolicy) return false;
  const scope = parseScope(args.scopeRaw);
  return scope.ok;
}

/**
 * Pure helper. Suggested capabilities for the autocomplete dropdown. For
 * kubernetes connectors we surface the curated `KNOWN_KUBERNETES_CAPABILITIES`
 * superset (covers verbs like apply/exec/port_forward the template doesn't
 * list). For other connector types we fall back to the template's
 * suggested list. Returns [] for unknown types instead of throwing so the
 * dialog still renders rather than crashing.
 *
 * Note: this list is suggestions only — the input is free-text, validated by
 * `isValidCapability`.
 */
export function capabilitiesFor(type: string): readonly string[] {
  if (type === 'kubernetes') return KNOWN_KUBERNETES_CAPABILITIES;
  try {
    return getConnectorTemplate(type as ConnectorType).capabilities ?? [];
  } catch {
    return [];
  }
}

const defaultApi: PoliciesApi = {
  async list(connectorId) {
    const { data, error } = await apiClient.get<{ policies: ConnectorTeamPolicy[] }>(
      `/connectors/${encodeURIComponent(connectorId)}/policies`,
    );
    if (error) throw new Error(error.message ?? 'Failed to load policies');
    return data?.policies ?? [];
  },
  async listTeams() {
    const { data, error } = await apiClient.get<{
      teams?: Array<{ id: string; name: string }>;
    }>(`/teams/search?perpage=200`);
    if (error) throw new Error(error.message ?? 'Failed to load teams');
    return (data?.teams ?? []).map((t) => ({ id: t.id, name: t.name }));
  },
  async upsert(connectorId, body) {
    const { data, error } = await apiClient.put<{ policy: ConnectorTeamPolicy }>(
      `/connectors/${encodeURIComponent(connectorId)}/policies`,
      body,
    );
    if (error) throw new Error(error.message ?? 'Failed to save policy');
    if (!data?.policy) throw new Error('Empty response from policy upsert');
    return data.policy;
  },
  async remove(connectorId, teamId, capability) {
    const { error } = await apiClient.delete<unknown>(
      `/connectors/${encodeURIComponent(connectorId)}/policies/${encodeURIComponent(
        teamId,
      )}/${encodeURIComponent(capability)}`,
    );
    if (error) throw new Error(error.message ?? 'Failed to delete policy');
  },
};

// Local copies of Settings.tsx form classes — keep visual parity without
// re-exporting strings across modules.
const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] text-[var(--color-on-surface)] text-sm placeholder-[var(--color-outline)] focus:outline-none focus:border-[var(--color-primary)] transition-colors';
const selectCls = inputCls;
const btnPrimary =
  'px-4 py-2 rounded-lg bg-[var(--color-primary)] text-[var(--color-on-primary-fixed)] text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity';
const btnSecondary =
  'px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] text-sm font-medium text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] disabled:opacity-50 transition-colors';

function policyKey(p: Pick<ConnectorTeamPolicy, 'teamId' | 'capability'>): string {
  return `${p.teamId}::${p.capability}`;
}

export function ConnectorPoliciesDialog(
  props: ConnectorPoliciesDialogProps,
): React.ReactElement | null {
  const { connector, onClose } = props;
  const api = props.api ?? defaultApi;

  const [policies, setPolicies] = useState<ConnectorTeamPolicy[]>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-row state.
  const [addTeamId, setAddTeamId] = useState('');
  const [addCapability, setAddCapability] = useState('');
  const [addHuman, setAddHuman] = useState<ConnectorHumanPolicy>('confirm');
  const [addAgent, setAddAgent] = useState<ConnectorAgentPolicy>('suggest');
  const [addScopeRaw, setAddScopeRaw] = useState('');
  const [adding, setAdding] = useState(false);

  // Delete confirm state.
  const [pendingDelete, setPendingDelete] =
    useState<{ teamId: string; capability: string } | null>(null);

  const capabilities = useMemo(() => capabilitiesFor(connector.type), [connector.type]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.list(connector.id), api.listTeams()])
      .then(([ps, ts]) => {
        if (cancelled) return;
        setPolicies(ps);
        setTeams(ts);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load policies');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, connector.id]);

  const teamName = useCallback(
    (id: string): string => {
      if (id === '') return 'All teams';
      return teams.find((t) => t.id === id)?.name ?? id;
    },
    [teams],
  );

  const handleChangePolicy = useCallback(
    async (
      row: ConnectorTeamPolicy,
      field: 'humanPolicy' | 'agentPolicy',
      next: ConnectorHumanPolicy | ConnectorAgentPolicy,
    ): Promise<void> => {
      const previous = row[field];
      // Optimistic update.
      setPolicies((prev) =>
        prev.map((p) =>
          policyKey(p) === policyKey(row) ? { ...p, [field]: next } : p,
        ),
      );
      try {
        await api.upsert(connector.id, {
          teamId: row.teamId,
          capability: row.capability,
          humanPolicy: field === 'humanPolicy' ? (next as ConnectorHumanPolicy) : row.humanPolicy,
          agentPolicy: field === 'agentPolicy' ? (next as ConnectorAgentPolicy) : row.agentPolicy,
          scope: row.scope,
        });
        setError(null);
      } catch (err) {
        // Roll back.
        setPolicies((prev) =>
          prev.map((p) =>
            policyKey(p) === policyKey(row) ? { ...p, [field]: previous } : p,
          ),
        );
        setError(err instanceof Error ? err.message : 'Failed to update policy');
      }
    },
    [api, connector.id],
  );

  const handleAdd = useCallback(async (): Promise<void> => {
    const scope = parseScope(addScopeRaw);
    if (!scope.ok) {
      setError(scope.message);
      return;
    }
    setAdding(true);
    try {
      const created = await api.upsert(connector.id, {
        teamId: addTeamId,
        capability: addCapability,
        humanPolicy: addHuman,
        agentPolicy: addAgent,
        scope: scope.value,
      });
      setPolicies((prev) => {
        // Replace if same (team,capability) already in list — backend is
        // upsert so we mirror that locally.
        const without = prev.filter((p) => policyKey(p) !== policyKey(created));
        return [...without, created];
      });
      setAddTeamId('');
      setAddCapability('');
      setAddScopeRaw('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add policy');
    } finally {
      setAdding(false);
    }
  }, [
    addScopeRaw,
    addTeamId,
    addCapability,
    addHuman,
    addAgent,
    api,
    connector.id,
  ]);

  const handleConfirmDelete = useCallback(async (): Promise<void> => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    const snapshot = policies;
    // Optimistic removal.
    setPolicies((prev) =>
      prev.filter(
        (p) => !(p.teamId === target.teamId && p.capability === target.capability),
      ),
    );
    try {
      await api.remove(connector.id, target.teamId, target.capability);
      setError(null);
    } catch (err) {
      setPolicies(snapshot);
      setError(err instanceof Error ? err.message : 'Failed to delete policy');
    }
  }, [api, connector.id, pendingDelete, policies]);

  const prefillFromDefault = useCallback(
    (seed: { capability: string; humanPolicy: ConnectorHumanPolicy; agentPolicy: ConnectorAgentPolicy }): void => {
      setAddTeamId('');
      setAddCapability(seed.capability);
      setAddHuman(seed.humanPolicy);
      setAddAgent(seed.agentPolicy);
      setAddScopeRaw('');
    },
    [],
  );

  const showKubernetesDefaults =
    connector.type === 'kubernetes' && policies.length === 0;

  const addEnabled =
    !adding &&
    canSubmitAdd({
      teamId: addTeamId,
      capability: addCapability,
      humanPolicy: addHuman,
      agentPolicy: addAgent,
      scopeRaw: addScopeRaw,
    });

  const content = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
      data-testid="connector-policies-dialog"
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Policies for ${connector.name}`}
        className="relative bg-[var(--color-surface-highest)] border border-[var(--color-outline-variant)] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-outline-variant)]/40">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-[var(--color-on-surface)]">
              Policies — {connector.name}
            </h3>
            <span className="rounded border border-[var(--color-outline-variant)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)]">
              {connector.type}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {error ? (
            <div
              role="alert"
              className="px-3 py-2 text-sm bg-error/10 text-error rounded-md"
              data-testid="policies-error"
            >
              {error}
            </div>
          ) : null}

          {loading ? (
            <div
              className="text-sm text-[var(--color-on-surface-variant)]"
              data-testid="policies-loading"
            >
              Loading policies…
            </div>
          ) : (
            <>
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)] mb-2">
                  Existing policies
                </h4>
                {policies.length === 0 && showKubernetesDefaults ? (
                  <div
                    className="rounded-md border border-[var(--color-outline-variant)]/40"
                    data-testid="policies-defaults"
                  >
                    <div className="px-3 py-2 bg-[var(--color-surface)] border-b border-[var(--color-outline-variant)]/40">
                      <div className="text-xs font-semibold text-[var(--color-on-surface)]">
                        Active defaults
                      </div>
                      <div className="text-xs text-[var(--color-on-surface-variant)] mt-1">
                        This connector has no explicit policies yet. The
                        defaults below are applied at runtime. Click any row
                        to customize it.
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--color-surface)]">
                          <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-on-surface-variant)]">
                            <th className="px-3 py-2 font-semibold">Capability</th>
                            <th className="px-3 py-2 font-semibold">Human</th>
                            <th className="px-3 py-2 font-semibold">Agent</th>
                            <th className="px-3 py-2 font-semibold w-px">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {KUBERNETES_DEFAULT_POLICIES.map((seed) => (
                            <tr
                              key={seed.capability}
                              className="border-t border-[var(--color-outline-variant)]/30"
                              data-testid={`default-row-${seed.capability}`}
                            >
                              <td className="px-3 py-2 font-mono text-xs text-[var(--color-on-surface)]">
                                {seed.capability}
                              </td>
                              <td className="px-3 py-2 text-[var(--color-on-surface)]">
                                {seed.humanPolicy}
                              </td>
                              <td className="px-3 py-2 text-[var(--color-on-surface)]">
                                {seed.agentPolicy}
                              </td>
                              <td className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => prefillFromDefault({
                                    capability: seed.capability,
                                    humanPolicy: seed.humanPolicy as ConnectorHumanPolicy,
                                    agentPolicy: seed.agentPolicy as ConnectorAgentPolicy,
                                  })}
                                  className="px-2 py-1 text-xs font-medium rounded border border-[var(--color-outline-variant)] text-[var(--color-on-surface)] hover:bg-[var(--color-surface-high)] transition-colors"
                                  data-testid={`edit-default-${seed.capability}`}
                                >
                                  Edit
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : policies.length === 0 ? (
                  <div
                    className="text-sm text-[var(--color-on-surface-variant)] italic px-3 py-3 bg-[var(--color-surface)] rounded-md border border-[var(--color-outline-variant)]/40"
                    data-testid="policies-empty"
                  >
                    No policies yet for this connector.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-[var(--color-outline-variant)]/40">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--color-surface)]">
                        <tr className="text-left text-xs uppercase tracking-wide text-[var(--color-on-surface-variant)]">
                          <th className="px-3 py-2 font-semibold">Team</th>
                          <th className="px-3 py-2 font-semibold">Capability</th>
                          <th className="px-3 py-2 font-semibold">Human</th>
                          <th className="px-3 py-2 font-semibold">Agent</th>
                          <th className="px-3 py-2 font-semibold">Scope</th>
                          <th className="px-3 py-2 font-semibold w-px">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {policies.map((p) => (
                          <tr
                            key={policyKey(p)}
                            className="border-t border-[var(--color-outline-variant)]/30"
                            data-testid={`policy-row-${p.teamId}-${p.capability}`}
                          >
                            <td className="px-3 py-2 text-[var(--color-on-surface)]">
                              {teamName(p.teamId)}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-[var(--color-on-surface)]">
                              {p.capability}
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={p.humanPolicy}
                                onChange={(e) =>
                                  void handleChangePolicy(
                                    p,
                                    'humanPolicy',
                                    e.target.value as ConnectorHumanPolicy,
                                  )
                                }
                                className={selectCls}
                                data-testid={`human-${p.teamId}-${p.capability}`}
                              >
                                {HUMAN_POLICY_OPTIONS.map((o) => (
                                  <option key={o} value={o}>
                                    {o}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={p.agentPolicy}
                                onChange={(e) =>
                                  void handleChangePolicy(
                                    p,
                                    'agentPolicy',
                                    e.target.value as ConnectorAgentPolicy,
                                  )
                                }
                                className={selectCls}
                                data-testid={`agent-${p.teamId}-${p.capability}`}
                              >
                                {AGENT_POLICY_OPTIONS.map((o) => (
                                  <option key={o} value={o}>
                                    {o}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-[var(--color-on-surface-variant)]">
                              {p.scope ? JSON.stringify(p.scope) : '—'}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setPendingDelete({
                                    teamId: p.teamId,
                                    capability: p.capability,
                                  })
                                }
                                className="px-2 py-1 text-xs font-medium rounded border border-[var(--color-outline-variant)] text-[var(--color-error)] hover:bg-error/10 transition-colors"
                                data-testid={`delete-${p.teamId}-${p.capability}`}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)] mb-2">
                  Add policy
                </h4>
                <div
                  className="rounded-md border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface)] p-3 grid grid-cols-1 md:grid-cols-6 gap-2"
                  data-testid="policies-add-row"
                >
                  <div className="md:col-span-1">
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)] mb-1">
                      Team
                    </label>
                    <select
                      value={addTeamId}
                      onChange={(e) => setAddTeamId(e.target.value)}
                      className={selectCls}
                      data-testid="add-team"
                    >
                      <option value="">All teams (default)</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-[10px] text-[var(--color-on-surface-variant)]">
                      Use "All teams" for a connector-wide default. Per-team
                      overrides apply when both exist.
                    </div>
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)] mb-1">
                      Capability
                    </label>
                    <input
                      type="text"
                      value={addCapability}
                      onChange={(e) => setAddCapability(e.target.value)}
                      list="connector-policy-capability-suggestions"
                      placeholder="runtime.apply"
                      autoComplete="off"
                      className={inputCls + ' font-mono'}
                      data-testid="add-capability"
                      aria-invalid={
                        addCapability.length > 0 && !isValidCapability(addCapability)
                          ? true
                          : undefined
                      }
                    />
                    <datalist id="connector-policy-capability-suggestions">
                      {capabilities.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    {addCapability.length > 0 && !isValidCapability(addCapability) ? (
                      <div
                        className="mt-1 text-[10px] text-[var(--color-error)]"
                        data-testid="capability-error"
                      >
                        Must match {`<area>.<verb>`} (e.g. runtime.apply)
                      </div>
                    ) : null}
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)] mb-1">
                      Human
                    </label>
                    <select
                      value={addHuman}
                      onChange={(e) => setAddHuman(e.target.value as ConnectorHumanPolicy)}
                      className={selectCls}
                      data-testid="add-human"
                    >
                      {HUMAN_POLICY_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)] mb-1">
                      Agent
                    </label>
                    <select
                      value={addAgent}
                      onChange={(e) => setAddAgent(e.target.value as ConnectorAgentPolicy)}
                      className={selectCls}
                      data-testid="add-agent"
                    >
                      {AGENT_POLICY_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-[10px] uppercase tracking-wide text-[var(--color-on-surface-variant)] mb-1">
                      Scope (JSON, optional)
                    </label>
                    <input
                      type="text"
                      value={addScopeRaw}
                      onChange={(e) => setAddScopeRaw(e.target.value)}
                      placeholder='{"env":"prod"}'
                      className={inputCls + ' font-mono'}
                      data-testid="add-scope"
                    />
                  </div>
                  <div className="md:col-span-1 flex items-end">
                    <button
                      type="button"
                      onClick={() => void handleAdd()}
                      disabled={!addEnabled}
                      className={btnPrimary + ' w-full'}
                      data-testid="add-submit"
                    >
                      {adding ? 'Adding…' : '+ Add'}
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-[var(--color-outline-variant)]/40">
          <button type="button" onClick={onClose} className={btnSecondary}>
            Close
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete policy"
        message={
          pendingDelete
            ? `Remove ${pendingDelete.capability} policy for team ${teamName(
                pendingDelete.teamId,
              )}? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );

  if (typeof document === 'undefined') return content;
  return ReactDOM.createPortal(content, document.body);
}

export default ConnectorPoliciesDialog;
