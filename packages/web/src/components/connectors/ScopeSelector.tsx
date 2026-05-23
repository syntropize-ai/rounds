import React from 'react';

export type PermissionScope =
  | { kind: 'org' }
  | { kind: 'team'; teamId: string };

export interface ScopeSelectorProps {
  scope: PermissionScope;
  onChange: (next: PermissionScope) => void;
  teams: ReadonlyArray<{ id: string; name: string }>;
  teamsLoading?: boolean;
  disabled?: boolean;
}

/**
 * Two-radio scope switcher: `Organization` (default) and `Team: <name ▾>`.
 * When `team` is selected, a `<select>` lists the org's teams (fetched by the
 * parent via /teams/search). If there are no teams the team option is
 * disabled with a hint.
 */
export function ScopeSelector({
  scope,
  onChange,
  teams,
  teamsLoading = false,
  disabled = false,
}: ScopeSelectorProps): React.ReactElement {
  const isTeam = scope.kind === 'team';
  const noTeams = !teamsLoading && teams.length === 0;
  const selectedTeamId = isTeam ? scope.teamId : teams[0]?.id ?? '';

  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <label className="inline-flex items-center gap-2 cursor-pointer">
        <input
          type="radio"
          name="connector-policy-scope"
          checked={!isTeam}
          disabled={disabled}
          onChange={() => onChange({ kind: 'org' })}
        />
        <span className="text-[var(--color-on-surface)]">Organization</span>
      </label>
      <label
        className={`inline-flex items-center gap-2 ${
          noTeams ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
        }`}
      >
        <input
          type="radio"
          name="connector-policy-scope"
          checked={isTeam}
          disabled={disabled || noTeams}
          onChange={() => {
            if (selectedTeamId) onChange({ kind: 'team', teamId: selectedTeamId });
          }}
        />
        <span className="text-[var(--color-on-surface)]">Team</span>
      </label>
      {isTeam && (
        <select
          aria-label="Team"
          value={isTeam ? scope.teamId : ''}
          disabled={disabled || noTeams}
          onChange={(e) => onChange({ kind: 'team', teamId: e.target.value })}
          className="rounded-md border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] px-2 py-1 text-sm text-[var(--color-on-surface)]"
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      {teamsLoading && (
        <span className="text-xs text-[var(--color-on-surface-variant)]">Loading teams…</span>
      )}
      {noTeams && (
        <span className="text-xs text-[var(--color-on-surface-variant)]">
          No teams in this org yet.
        </span>
      )}
    </div>
  );
}

export default ScopeSelector;
