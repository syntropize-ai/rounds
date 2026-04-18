/**
 * ApiKeyService — issues, looks up, and revokes opaque API tokens.
 *
 * Covers three callers:
 *   - Service-account tokens (`openobs_sa_<b64>`): owned by an SA user row.
 *   - Personal access tokens (`openobs_pat_<b64>`): owned by a human user.
 *     [openobs-extension] — Grafana deprecated PATs in favour of SA tokens.
 *   - Legacy `/api/auth/keys` — thin back-compat shim over issueServiceAccountToken
 *     (created on demand against a synthetic SA per the T9 cutover spec).
 *
 * Token format (matches `pkg/components/apikeygen/apikeygen.go` semantics):
 *   1. 32 random bytes → base64url (length 43, no padding).
 *   2. Prefix with `openobs_sa_` or `openobs_pat_`.
 *   3. SHA-256 hex stored in api_key.key — plaintext never persisted.
 *   4. Plaintext returned exactly once in the create response.
 *
 * Validation: `validateAndLookup` hashes the provided plaintext, fetches the
 * row via IApiKeyRepository, honours `is_revoked` + `expires`, then resolves
 * the authenticated principal (SA or PAT owner). Used by the api_key branch
 * of the auth middleware (T6.3).
 *
 * Audit rate-limiting: `apikey.used` events are coalesced in-memory to at
 * most one per minute per key id so a busy agent doesn't flood the log.
 * State is process-local — fine for our single-process deployment.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  AuditAction,
  ORG_ROLES,
  type ApiKey,
  type IApiKeyRepository,
  type IOrgUserRepository,
  type IQuotaRepository,
  type IUserRepository,
  type OrgRole,
  type User,
} from '@agentic-obs/common';
import type { AuditWriter } from '../auth/audit-writer.js';

export const TOKEN_PREFIX_SA = 'openobs_sa_';
export const TOKEN_PREFIX_PAT = 'openobs_pat_';

export class ApiKeyServiceError extends Error {
  constructor(
    public readonly kind:
      | 'validation'
      | 'not_found'
      | 'quota_exceeded'
      | 'conflict',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ApiKeyServiceError';
  }
}

export interface IssueSATokenInput {
  name: string;
  /** Lifetime in seconds from now; null/undefined = never expire. */
  secondsToLive?: number | null;
}

export interface IssuePATInput {
  name: string;
  secondsToLive?: number | null;
  /** PAT role defaults to the owning user's org role at issue time. */
  role?: OrgRole;
}

export interface IssuedToken {
  id: string;
  name: string;
  /** Plaintext — MUST be returned to the caller exactly once. */
  key: string;
  orgId: string;
  serviceAccountId: string | null;
  ownerUserId: string | null;
  expires: string | null;
  created: string;
}

export interface ApiKeyLookup {
  user: User;
  orgId: string;
  role: OrgRole;
  serviceAccountId: string | null;
  keyId: string;
  isServerAdmin: boolean;
}

export interface ApiKeyServiceDeps {
  apiKeys: IApiKeyRepository;
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  quotas?: IQuotaRepository;
  audit: AuditWriter;
  /** Override the rate-limit window (ms) for audit `apikey.used`. */
  usedAuditCooldownMs?: number;
  /** Test-only clock. */
  now?: () => number;
}

// -- helpers ---------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function randomTokenCore(): string {
  // 32 bytes → 43 chars base64url (no padding).
  return randomBytes(32).toString('base64url');
}

export function generateSAToken(): { plaintext: string; hashed: string } {
  const plaintext = `${TOKEN_PREFIX_SA}${randomTokenCore()}`;
  return { plaintext, hashed: sha256Hex(plaintext) };
}

export function generatePATToken(): { plaintext: string; hashed: string } {
  const plaintext = `${TOKEN_PREFIX_PAT}${randomTokenCore()}`;
  return { plaintext, hashed: sha256Hex(plaintext) };
}

function parseQuotaLimit(
  env: NodeJS.ProcessEnv,
  key: string,
): number {
  const v = env[key];
  if (!v) return -1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : -1;
}

// -- service ---------------------------------------------------------------

export class ApiKeyService {
  private readonly usedAuditAt = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: ApiKeyServiceDeps,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.cooldownMs = deps.usedAuditCooldownMs ?? 60_000;
    this.now = deps.now ?? (() => Date.now());
  }

  // -- issue ---------------------------------------------------------------

  async issueServiceAccountToken(
    orgId: string,
    serviceAccountId: string,
    input: IssueSATokenInput,
  ): Promise<IssuedToken> {
    const name = input.name?.trim();
    if (!name) {
      throw new ApiKeyServiceError('validation', 'name is required', 400);
    }
    const sa = await this.deps.users.findById(serviceAccountId);
    if (!sa || !sa.isServiceAccount || sa.orgId !== orgId) {
      throw new ApiKeyServiceError(
        'not_found',
        'service account not found',
        404,
      );
    }

    // Quota: per-SA cap on active tokens. Env override lets operators cap the
    // default; otherwise unlimited.
    await this.enforceTokenQuota({
      target: 'api_keys',
      orgId,
      serviceAccountId,
      envLimit: parseQuotaLimit(this.env, 'QUOTA_API_KEYS_PER_SA'),
    });

    // Resolve SA's org role — used for api_key.role (legacy column).
    const membership = await this.deps.orgUsers.findMembership(
      orgId,
      serviceAccountId,
    );
    const role = membership?.role ?? 'Viewer';

    const { plaintext, hashed } = generateSAToken();
    const expires = this.computeExpiry(input.secondsToLive);

    const row = await this.deps.apiKeys.create({
      orgId,
      name,
      key: hashed,
      role,
      serviceAccountId,
      ownerUserId: null,
      expires,
    });

    void this.deps.audit.log({
      action: AuditAction.ServiceAccountTokenCreated,
      actorType: 'service_account',
      actorId: serviceAccountId,
      orgId,
      targetType: 'api_key',
      targetId: row.id,
      targetName: name,
      outcome: 'success',
    });

    return {
      id: row.id,
      name: row.name,
      key: plaintext,
      orgId,
      serviceAccountId,
      ownerUserId: null,
      expires: row.expires,
      created: row.created,
    };
  }

  async issuePersonalAccessToken(
    orgId: string,
    userId: string,
    input: IssuePATInput,
  ): Promise<IssuedToken> {
    const name = input.name?.trim();
    if (!name) {
      throw new ApiKeyServiceError('validation', 'name is required', 400);
    }
    if (input.role !== undefined && !ORG_ROLES.includes(input.role)) {
      throw new ApiKeyServiceError(
        'validation',
        `role must be one of: ${ORG_ROLES.join(', ')}`,
        400,
      );
    }

    const user = await this.deps.users.findById(userId);
    if (!user) {
      throw new ApiKeyServiceError('not_found', 'user not found', 404);
    }
    if (user.isServiceAccount) {
      throw new ApiKeyServiceError(
        'validation',
        'service accounts must use SA tokens',
        400,
      );
    }

    // Quota: per-user PAT cap.
    await this.enforceTokenQuota({
      target: 'api_keys',
      userId,
      envLimit: parseQuotaLimit(this.env, 'QUOTA_API_KEYS_PER_USER'),
    });

    const membership = await this.deps.orgUsers.findMembership(orgId, userId);
    const role = input.role ?? membership?.role ?? 'Viewer';

    const { plaintext, hashed } = generatePATToken();
    const expires = this.computeExpiry(input.secondsToLive);

    const row = await this.deps.apiKeys.create({
      orgId,
      name,
      key: hashed,
      role,
      serviceAccountId: null,
      ownerUserId: userId,
      expires,
    });

    void this.deps.audit.log({
      action: AuditAction.ApiKeyCreated,
      actorType: 'user',
      actorId: userId,
      orgId,
      targetType: 'api_key',
      targetId: row.id,
      targetName: name,
      outcome: 'success',
    });

    return {
      id: row.id,
      name: row.name,
      key: plaintext,
      orgId,
      serviceAccountId: null,
      ownerUserId: userId,
      expires: row.expires,
      created: row.created,
    };
  }

  // -- list ----------------------------------------------------------------

  async listByServiceAccount(
    orgId: string,
    serviceAccountId: string,
  ): Promise<ApiKey[]> {
    const page = await this.deps.apiKeys.list({
      orgId,
      serviceAccountId,
      includeRevoked: true,
      includeExpired: true,
      limit: 1000,
    });
    return page.items;
  }

  async listByOwner(orgId: string, userId: string): Promise<ApiKey[]> {
    // Repository doesn't currently filter by owner_user_id directly; we scope
    // on org then post-filter. Token counts per user are small in practice.
    const page = await this.deps.apiKeys.list({
      orgId,
      serviceAccountId: null,
      includeRevoked: true,
      includeExpired: true,
      limit: 1000,
    });
    return page.items.filter((k) => k.ownerUserId === userId);
  }

  async getById(orgId: string, keyId: string): Promise<ApiKey | null> {
    const row = await this.deps.apiKeys.findById(keyId);
    if (!row || row.orgId !== orgId) return null;
    return row;
  }

  // -- revoke --------------------------------------------------------------

  async revoke(orgId: string, keyId: string, actorId: string): Promise<void> {
    const row = await this.deps.apiKeys.findById(keyId);
    if (!row || row.orgId !== orgId) {
      throw new ApiKeyServiceError('not_found', 'api key not found', 404);
    }
    if (row.isRevoked) {
      // Idempotent no-op: per §06 already-revoked revoke() must not error.
      return;
    }
    await this.deps.apiKeys.revoke(keyId);
    const action = row.serviceAccountId
      ? AuditAction.ServiceAccountTokenRevoked
      : AuditAction.ApiKeyRevoked;
    void this.deps.audit.log({
      action,
      actorType: 'user',
      actorId,
      orgId,
      targetType: 'api_key',
      targetId: row.id,
      targetName: row.name,
      outcome: 'success',
    });
  }

  // -- lookup (used by middleware) -----------------------------------------

  async validateAndLookup(rawToken: string): Promise<ApiKeyLookup | null> {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const hashed = sha256Hex(rawToken);
    const row = await this.deps.apiKeys.findByHashedKey(hashed);
    if (!row) return null;
    if (row.isRevoked) return null;
    if (row.expires && Date.parse(row.expires) < this.now()) return null;

    const principalId = row.serviceAccountId ?? row.ownerUserId;
    if (!principalId) return null;
    const user = await this.deps.users.findById(principalId);
    if (!user || user.isDisabled) return null;

    const membership = await this.deps.orgUsers.findMembership(
      row.orgId,
      principalId,
    );
    const role: OrgRole = membership?.role ?? 'None';

    // Touch last-used + rate-limited audit; both fire-and-forget.
    void this.deps.apiKeys
      .touchLastUsed(row.id, new Date().toISOString())
      .catch(() => undefined);
    this.maybeAuditUsed(row);

    return {
      user,
      orgId: row.orgId,
      role,
      serviceAccountId: row.serviceAccountId,
      keyId: row.id,
      isServerAdmin: user.isAdmin,
    };
  }

  // -- internals -----------------------------------------------------------

  private computeExpiry(secondsToLive?: number | null): string | null {
    if (secondsToLive === undefined || secondsToLive === null) return null;
    if (!Number.isFinite(secondsToLive) || secondsToLive <= 0) return null;
    return new Date(this.now() + secondsToLive * 1000).toISOString();
  }

  private maybeAuditUsed(row: ApiKey): void {
    const last = this.usedAuditAt.get(row.id) ?? 0;
    const now = this.now();
    if (now - last < this.cooldownMs) return;
    this.usedAuditAt.set(row.id, now);
    // Opportunistic cleanup: purge entries older than 10x window.
    if (this.usedAuditAt.size > 1024) {
      const cutoff = now - this.cooldownMs * 10;
      for (const [k, v] of this.usedAuditAt) {
        if (v < cutoff) this.usedAuditAt.delete(k);
      }
    }
    const actor = row.serviceAccountId ?? row.ownerUserId ?? undefined;
    const actorType: 'service_account' | 'user' = row.serviceAccountId
      ? 'service_account'
      : 'user';
    void this.deps.audit.log({
      action: AuditAction.ApiKeyUsed,
      actorType,
      actorId: actor,
      orgId: row.orgId,
      targetType: 'api_key',
      targetId: row.id,
      targetName: row.name,
      outcome: 'success',
    });
  }

  private async enforceTokenQuota(params: {
    target: 'api_keys';
    orgId?: string;
    userId?: string;
    serviceAccountId?: string;
    envLimit: number;
  }): Promise<void> {
    let limit = params.envLimit;
    if (this.deps.quotas) {
      if (params.userId) {
        const row = await this.deps.quotas.findUserQuota(
          params.userId,
          params.target,
        );
        if (row && Number.isFinite(row.limitVal)) limit = row.limitVal;
      }
    }
    if (limit < 0) return; // unlimited
    let current = 0;
    if (params.serviceAccountId && params.orgId) {
      const page = await this.deps.apiKeys.list({
        orgId: params.orgId,
        serviceAccountId: params.serviceAccountId,
      });
      current = page.total;
    } else if (params.userId) {
      // Count active PATs owned by this user.
      const rows = await this.listByOwner(params.orgId ?? '', params.userId);
      current = rows.filter((r) => !r.isRevoked).length;
    }
    if (current >= limit) {
      throw new ApiKeyServiceError('quota_exceeded', 'Quota exceeded', 403);
    }
  }

  // -- bulk migrate --------------------------------------------------------

  /**
   * Parse the legacy `API_KEYS` env var. Format: `name:key,name2:key2`.
   * Returns empty list when the env var is unset / blank.
   */
  parseLegacyEnv(): Array<{ name: string; key: string }> {
    const raw = this.env['API_KEYS'];
    if (!raw) return [];
    const out: Array<{ name: string; key: string }> = [];
    for (const pair of raw.split(',')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue;
      const name = trimmed.slice(0, idx).trim();
      const key = trimmed.slice(idx + 1).trim();
      if (!name || !key) continue;
      out.push({ name, key });
    }
    return out;
  }

  /**
   * Import a pre-existing legacy key as an SA token — used by the migrate
   * endpoint. Bypasses quota (operator-driven one-shot) and stores the
   * provided plaintext's SHA-256 so downstream clients don't need to
   * change their token. Idempotent: silently skips names already mapped.
   */
  async importLegacyKeyForSA(
    orgId: string,
    serviceAccountId: string,
    legacyName: string,
    legacyKey: string,
  ): Promise<ApiKey> {
    const hashed = sha256Hex(legacyKey);
    const existing = await this.deps.apiKeys.findByHashedKey(hashed);
    if (existing) return existing;

    const membership = await this.deps.orgUsers.findMembership(
      orgId,
      serviceAccountId,
    );
    const role = membership?.role ?? 'Viewer';
    return this.deps.apiKeys.create({
      orgId,
      name: legacyName,
      key: hashed,
      role,
      serviceAccountId,
      ownerUserId: null,
      expires: null,
    });
  }
}
