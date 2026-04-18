import React from 'react';
import type { BuiltInRoleName, PermissionLevel } from '@agentic-obs/common';
import { UserSearchField, type UserSearchResult } from './UserSearchField.js';
import { TeamSearchField, type TeamSearchResult } from './TeamSearchField.js';
import type { DraftDirectEntry } from './helpers.js';

type PrincipalType = 'role' | 'user' | 'team';

interface Props {
  onAdd: (draft: DraftDirectEntry) => void;
  onClose: () => void;
}

/**
 * Inline flyout for composing a new permission grant. Exposes three
 * principal-type radios (Role / User / Team) and a level dropdown.
 *
 * License hygiene: generic picker composed from our own primitives.
 */
export function AddPermissionFlyout({ onAdd, onClose }: Props): React.ReactElement {
  const [type, setType] = React.useState<PrincipalType>('role');
  const [role, setRole] = React.useState<BuiltInRoleName>('Viewer');
  const [level, setLevel] = React.useState<PermissionLevel>(1);
  const [pickedUser, setPickedUser] = React.useState<UserSearchResult | null>(null);
  const [pickedTeam, setPickedTeam] = React.useState<TeamSearchResult | null>(null);

  const canConfirm =
    (type === 'role') ||
    (type === 'user' && pickedUser !== null) ||
    (type === 'team' && pickedTeam !== null);

  const confirm = () => {
    if (type === 'role') {
      onAdd({ kind: 'role', role, label: role, level });
    } else if (type === 'user' && pickedUser) {
      onAdd({
        kind: 'user',
        userId: pickedUser.userId,
        label: pickedUser.email || pickedUser.login,
        level,
      });
    } else if (type === 'team' && pickedTeam) {
      onAdd({ kind: 'team', teamId: pickedTeam.teamId, label: pickedTeam.name, level });
    }
  };

  return (
    <div
      data-testid="add-permission-flyout"
      className="p-4 bg-surface-high rounded-xl border border-outline-variant space-y-3"
    >
      <div className="flex items-center gap-4 text-sm text-on-surface">
        {(['role', 'user', 'team'] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5 cursor-pointer capitalize">
            <input
              type="radio"
              name="principal-type"
              value={t}
              checked={type === t}
              onChange={() => setType(t)}
              className="accent-primary"
            />
            {t}
          </label>
        ))}
      </div>

      {type === 'role' ? (
        <select
          aria-label="Built-in role"
          value={role}
          onChange={(e) => setRole(e.target.value as BuiltInRoleName)}
          className="w-full bg-surface-highest text-on-surface text-sm rounded-md px-2 py-1.5 border border-outline focus:ring-1 focus:ring-primary outline-none"
        >
          <option value="Admin">Admin</option>
          <option value="Editor">Editor</option>
          <option value="Viewer">Viewer</option>
        </select>
      ) : null}

      {type === 'user' ? (
        pickedUser ? (
          <div className="flex items-center gap-2 text-sm text-on-surface">
            <span className="flex-1 truncate">{pickedUser.email || pickedUser.login}</span>
            <button
              type="button"
              onClick={() => setPickedUser(null)}
              className="text-xs text-on-surface-variant hover:text-on-surface underline"
            >
              change
            </button>
          </div>
        ) : (
          <UserSearchField onSelect={setPickedUser} />
        )
      ) : null}

      {type === 'team' ? (
        pickedTeam ? (
          <div className="flex items-center gap-2 text-sm text-on-surface">
            <span className="flex-1 truncate">{pickedTeam.name}</span>
            <button
              type="button"
              onClick={() => setPickedTeam(null)}
              className="text-xs text-on-surface-variant hover:text-on-surface underline"
            >
              change
            </button>
          </div>
        ) : (
          <TeamSearchField onSelect={setPickedTeam} />
        )
      ) : null}

      <div className="flex items-center gap-2">
        <label className="text-xs text-on-surface-variant">Level</label>
        <select
          aria-label="Permission level"
          value={level}
          onChange={(e) => setLevel(Number(e.target.value) as PermissionLevel)}
          className="bg-surface-highest text-on-surface text-sm rounded-md px-2 py-1.5 border border-outline focus:ring-1 focus:ring-primary outline-none"
        >
          <option value={1}>View</option>
          <option value={2}>Edit</option>
          <option value={4}>Admin</option>
        </select>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface rounded-md hover:bg-surface-bright transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={!canConfirm}
          className="px-3 py-1.5 text-xs font-semibold bg-primary text-on-primary-fixed rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-transform active:scale-95"
        >
          Add
        </button>
      </div>
    </div>
  );
}
