/**
 * Shared inline rename modal for an org. Used from:
 *   - `/admin/orgs` — Server-admin Organizations list (T8.6)
 *   - `/admin/orgs/:id` — Per-org members page (server-admin drill-down)
 *
 * Wraps `PUT /api/orgs/:id` with the same name-only payload the Grafana
 * `/api/orgs/:id` endpoint accepts (see docs/auth-perm-design/08-api-surface.md).
 * Lifted out of `Orgs.tsx` when the second caller landed — the third caller
 * is the natural trigger to generalize further.
 */

import React, { useState } from 'react';
import { api } from '../../api/client.js';
import {
  ErrorBanner,
  Modal,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from './_ui.js';
import type { OrgDTO } from './_shared.js';

export function RenameOrgModal({
  org,
  onClose,
  onSaved,
}: {
  org: OrgDTO;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactElement {
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`Rename — ${org.name}`}>
      <ErrorBanner message={error} />
      <TextInput value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex justify-end gap-2 mt-5">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={!name.trim() || saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.put(`/orgs/${org.id}`, { name });
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Failed to rename organization');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}
