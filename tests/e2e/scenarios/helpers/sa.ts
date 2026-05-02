/**
 * Service-account + role-assignment helpers for RBAC scenarios.
 *
 * Creates ephemeral SAs, mints/revokes their tokens, and toggles
 * fixed-role assignments. Use with care — every SA should be deleted in
 * afterAll to keep the org clean.
 */
import { apiPost, apiDelete } from './api-client.js';

export interface SaTokenPair {
  saId: string;
  tokenId: string;
  token: string;
}

interface CreateSaResp { id: string; name: string }
interface CreateTokenResp { id: string; key: string }

let counter = 0;

export type SaRole = 'Viewer' | 'Editor' | 'Admin';

export async function mintSaToken(
  nameOrOpts?: string | { name?: string; role?: SaRole },
): Promise<SaTokenPair> {
  counter += 1;
  const opts = typeof nameOrOpts === 'string' ? { name: nameOrOpts } : nameOrOpts ?? {};
  const saName = opts.name ?? `e2e-sa-${Date.now()}-${counter}`;
  const role: SaRole = opts.role ?? 'Admin';
  const sa = await apiPost<CreateSaResp>('/api/serviceaccounts', {
    name: saName,
    role,
  });
  const token = await apiPost<CreateTokenResp>(
    `/api/serviceaccounts/${sa.id}/tokens`,
    { name: `${saName}-token` },
  );
  return { saId: sa.id, tokenId: token.id, token: token.key };
}

export async function revokeSaToken(saId: string, tokenId: string): Promise<void> {
  try {
    await apiDelete(`/api/serviceaccounts/${saId}/tokens/${tokenId}`);
  } catch {
    /* best effort */
  }
}

export async function deleteSa(saId: string): Promise<void> {
  try {
    await apiDelete(`/api/serviceaccounts/${saId}`);
  } catch {
    /* best effort */
  }
}

export async function assignRole(saId: string, roleUid: string): Promise<void> {
  await apiPost(`/api/access-control/users/${saId}/roles`, { roleUid });
}

export async function removeRole(saId: string, roleUid: string): Promise<void> {
  try {
    await apiDelete(`/api/access-control/users/${saId}/roles/${roleUid}`);
  } catch {
    /* best effort */
  }
}
