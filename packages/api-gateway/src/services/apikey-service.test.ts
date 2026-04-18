/**
 * ApiKeyService unit tests — T6.2, T6.3.
 *
 * Coverage target: token issue/list/revoke for both SA + PAT; SHA-256
 * round-trip; expiry; rate-limited audit; legacy env parse; validateAndLookup
 * error paths.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AuditLogRepository,
  ApiKeyRepository,
  OrgUserRepository,
  UserRepository,
  createTestDb,
  seedDefaultOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { AuditWriter } from '../auth/audit-writer.js';
import {
  ApiKeyService,
  ApiKeyServiceError,
  TOKEN_PREFIX_PAT,
  TOKEN_PREFIX_SA,
  generatePATToken,
  generateSAToken,
} from './apikey-service.js';

interface Ctx {
  db: SqliteClient;
  users: UserRepository;
  orgUsers: OrgUserRepository;
  apiKeys: ApiKeyRepository;
  audit: AuditLogRepository;
  svc: ApiKeyService;
  humanUserId: string;
  saId: string;
}

async function build(): Promise<Ctx> {
  const db = createTestDb();
  await seedDefaultOrg(db);
  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const audit = new AuditWriter(auditRepo);

  const human = await users.create({
    email: 'h@t.local',
    name: 'Human',
    login: 'human',
    orgId: 'org_main',
  });
  await orgUsers.create({ orgId: 'org_main', userId: human.id, role: 'Editor' });

  const sa = await users.create({
    email: 'sa@t.local',
    name: 'SA',
    login: 'sa-prom',
    orgId: 'org_main',
    isServiceAccount: true,
  });
  await orgUsers.create({ orgId: 'org_main', userId: sa.id, role: 'Viewer' });

  const svc = new ApiKeyService({
    apiKeys,
    users,
    orgUsers,
    audit,
  });
  return {
    db,
    users,
    orgUsers,
    apiKeys,
    audit: auditRepo,
    svc,
    humanUserId: human.id,
    saId: sa.id,
  };
}

describe('token generation', () => {
  it('prefixes SA tokens with openobs_sa_', () => {
    const { plaintext, hashed } = generateSAToken();
    expect(plaintext.startsWith(TOKEN_PREFIX_SA)).toBe(true);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHash('sha256').update(plaintext).digest('hex');
    expect(hashed).toBe(expected);
  });
  it('prefixes PATs with openobs_pat_', () => {
    const { plaintext } = generatePATToken();
    expect(plaintext.startsWith(TOKEN_PREFIX_PAT)).toBe(true);
  });
  it('produces distinct tokens on repeat', () => {
    const a = generateSAToken();
    const b = generateSAToken();
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe('ApiKeyService.issueServiceAccountToken', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('returns plaintext once and stores the hash', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'k1' },
    );
    expect(issued.key.startsWith(TOKEN_PREFIX_SA)).toBe(true);
    const hashed = createHash('sha256').update(issued.key).digest('hex');
    const row = await ctx.apiKeys.findByHashedKey(hashed);
    expect(row?.id).toBe(issued.id);
    expect(row?.key).toBe(hashed);
    // The row never stores plaintext.
    expect(row?.key).not.toBe(issued.key);
  });

  it('rejects blank name (400)', async () => {
    await expect(
      ctx.svc.issueServiceAccountToken('org_main', ctx.saId, { name: '' }),
    ).rejects.toMatchObject({ kind: 'validation', statusCode: 400 });
  });

  it('404 when SA not found', async () => {
    await expect(
      ctx.svc.issueServiceAccountToken('org_main', 'u_missing', { name: 'n' }),
    ).rejects.toMatchObject({ kind: 'not_found', statusCode: 404 });
  });

  it('404 when target user is not an SA', async () => {
    await expect(
      ctx.svc.issueServiceAccountToken('org_main', ctx.humanUserId, {
        name: 'n',
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('honours secondsToLive', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'short', secondsToLive: 60 },
    );
    expect(issued.expires).not.toBeNull();
    const delta = Date.parse(issued.expires!) - Date.now();
    expect(delta).toBeGreaterThan(55 * 1000);
    expect(delta).toBeLessThan(65 * 1000);
  });

  it('null expiry when no secondsToLive', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'forever' },
    );
    expect(issued.expires).toBeNull();
  });

  it('audit event serviceaccount.token_created', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'logged' },
    );
    await new Promise((r) => setTimeout(r, 10));
    const rows = await ctx.audit.query({
      action: 'serviceaccount.token_created',
    });
    expect(rows.items.some((r) => r.targetId === issued.id)).toBe(true);
  });
});

describe('ApiKeyService.issuePersonalAccessToken', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('returns plaintext, stores hash, owner set', async () => {
    const issued = await ctx.svc.issuePersonalAccessToken(
      'org_main',
      ctx.humanUserId,
      { name: 'pat1' },
    );
    const row = await ctx.apiKeys.findById(issued.id);
    expect(row?.serviceAccountId).toBeNull();
    expect(row?.ownerUserId).toBe(ctx.humanUserId);
    expect(issued.key.startsWith(TOKEN_PREFIX_PAT)).toBe(true);
  });

  it('refuses SA as owner', async () => {
    await expect(
      ctx.svc.issuePersonalAccessToken('org_main', ctx.saId, { name: 'x' }),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('defaults PAT role to owner org role', async () => {
    const issued = await ctx.svc.issuePersonalAccessToken(
      'org_main',
      ctx.humanUserId,
      { name: 'p' },
    );
    const row = await ctx.apiKeys.findById(issued.id);
    expect(row?.role).toBe('Editor');
  });

  it('audit event apikey.created', async () => {
    const issued = await ctx.svc.issuePersonalAccessToken(
      'org_main',
      ctx.humanUserId,
      { name: 'ac' },
    );
    await new Promise((r) => setTimeout(r, 10));
    const rows = await ctx.audit.query({ action: 'apikey.created' });
    expect(rows.items.some((r) => r.targetId === issued.id)).toBe(true);
  });
});

describe('ApiKeyService.validateAndLookup', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('resolves a fresh SA token to (user, orgId, role)', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'v' },
    );
    const lookup = await ctx.svc.validateAndLookup(issued.key);
    expect(lookup?.user.id).toBe(ctx.saId);
    expect(lookup?.orgId).toBe('org_main');
    expect(lookup?.role).toBe('Viewer');
    expect(lookup?.serviceAccountId).toBe(ctx.saId);
  });

  it('null when token unknown', async () => {
    expect(await ctx.svc.validateAndLookup('openobs_sa_bogus')).toBeNull();
    expect(await ctx.svc.validateAndLookup('')).toBeNull();
  });

  it('null when revoked', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'r' },
    );
    await ctx.svc.revoke('org_main', issued.id, ctx.humanUserId);
    expect(await ctx.svc.validateAndLookup(issued.key)).toBeNull();
  });

  it('null when expired', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'e' },
    );
    // Manually backdate expiry via repo update.
    await ctx.apiKeys.update(issued.id, {
      expires: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await ctx.svc.validateAndLookup(issued.key)).toBeNull();
  });

  it('null when principal is disabled', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'd' },
    );
    await ctx.users.update(ctx.saId, { isDisabled: true });
    expect(await ctx.svc.validateAndLookup(issued.key)).toBeNull();
  });

  it('PAT resolves to owner user', async () => {
    const pat = await ctx.svc.issuePersonalAccessToken(
      'org_main',
      ctx.humanUserId,
      { name: 'p' },
    );
    const lookup = await ctx.svc.validateAndLookup(pat.key);
    expect(lookup?.user.id).toBe(ctx.humanUserId);
    expect(lookup?.serviceAccountId).toBeNull();
  });
});

describe('ApiKeyService.revoke', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('marks is_revoked=1', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'z' },
    );
    await ctx.svc.revoke('org_main', issued.id, ctx.humanUserId);
    const row = await ctx.apiKeys.findById(issued.id);
    expect(row?.isRevoked).toBe(true);
  });

  it('is idempotent on already-revoked', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'y' },
    );
    await ctx.svc.revoke('org_main', issued.id, ctx.humanUserId);
    await expect(
      ctx.svc.revoke('org_main', issued.id, ctx.humanUserId),
    ).resolves.toBeUndefined();
  });

  it('404 on unknown id', async () => {
    await expect(
      ctx.svc.revoke('org_main', 'apikey_missing', ctx.humanUserId),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('audit event serviceaccount.token_revoked for SA token', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'au' },
    );
    await ctx.svc.revoke('org_main', issued.id, ctx.humanUserId);
    await new Promise((r) => setTimeout(r, 10));
    const rows = await ctx.audit.query({
      action: 'serviceaccount.token_revoked',
    });
    expect(rows.items.some((r) => r.targetId === issued.id)).toBe(true);
  });

  it('audit event apikey.revoked for PAT', async () => {
    const pat = await ctx.svc.issuePersonalAccessToken(
      'org_main',
      ctx.humanUserId,
      { name: 'pr' },
    );
    await ctx.svc.revoke('org_main', pat.id, ctx.humanUserId);
    await new Promise((r) => setTimeout(r, 10));
    const rows = await ctx.audit.query({ action: 'apikey.revoked' });
    expect(rows.items.some((r) => r.targetId === pat.id)).toBe(true);
  });
});

describe('ApiKeyService.list', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('listByServiceAccount returns all keys including revoked', async () => {
    const a = await ctx.svc.issueServiceAccountToken('org_main', ctx.saId, {
      name: 'a',
    });
    const b = await ctx.svc.issueServiceAccountToken('org_main', ctx.saId, {
      name: 'b',
    });
    await ctx.svc.revoke('org_main', b.id, ctx.humanUserId);
    const rows = await ctx.svc.listByServiceAccount('org_main', ctx.saId);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('listByOwner only returns PATs for that user', async () => {
    await ctx.svc.issuePersonalAccessToken('org_main', ctx.humanUserId, {
      name: 'mine',
    });
    await ctx.svc.issueServiceAccountToken('org_main', ctx.saId, {
      name: 'not-mine',
    });
    const rows = await ctx.svc.listByOwner('org_main', ctx.humanUserId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe('mine');
  });
});

describe('ApiKeyService.apikey.used audit is rate-limited', () => {
  it('emits once per minute per key id', async () => {
    const ctx = await build();
    let clock = 1_000_000;
    const svc = new ApiKeyService({
      apiKeys: ctx.apiKeys,
      users: ctx.users,
      orgUsers: ctx.orgUsers,
      audit: new AuditWriter(ctx.audit),
      now: () => clock,
      usedAuditCooldownMs: 60_000,
    });
    const issued = await svc.issueServiceAccountToken('org_main', ctx.saId, {
      name: 'rl',
    });
    await svc.validateAndLookup(issued.key);
    await svc.validateAndLookup(issued.key);
    await svc.validateAndLookup(issued.key);
    // Advance past cooldown.
    clock += 61_000;
    await svc.validateAndLookup(issued.key);
    // Let fire-and-forget writes flush.
    await new Promise((r) => setTimeout(r, 20));
    const rows = await ctx.audit.query({ action: 'apikey.used' });
    expect(rows.items.filter((r) => r.targetId === issued.id).length).toBe(2);
  });
});

describe('ApiKeyService.parseLegacyEnv', () => {
  it('returns empty when env var missing', () => {
    const db = createTestDb();
    const svc = new ApiKeyService(
      {
        apiKeys: new ApiKeyRepository(db),
        users: new UserRepository(db),
        orgUsers: new OrgUserRepository(db),
        audit: new AuditWriter(new AuditLogRepository(db)),
      },
      {},
    );
    expect(svc.parseLegacyEnv()).toEqual([]);
  });

  it('parses name:key pairs separated by commas', () => {
    const db = createTestDb();
    const svc = new ApiKeyService(
      {
        apiKeys: new ApiKeyRepository(db),
        users: new UserRepository(db),
        orgUsers: new OrgUserRepository(db),
        audit: new AuditWriter(new AuditLogRepository(db)),
      },
      { API_KEYS: 'one:aaa, two:bbb, three:ccc' },
    );
    expect(svc.parseLegacyEnv()).toEqual([
      { name: 'one', key: 'aaa' },
      { name: 'two', key: 'bbb' },
      { name: 'three', key: 'ccc' },
    ]);
  });

  it('skips malformed pairs', () => {
    const db = createTestDb();
    const svc = new ApiKeyService(
      {
        apiKeys: new ApiKeyRepository(db),
        users: new UserRepository(db),
        orgUsers: new OrgUserRepository(db),
        audit: new AuditWriter(new AuditLogRepository(db)),
      },
      { API_KEYS: 'valid:ok,bad,:nonpair,name:' },
    );
    expect(svc.parseLegacyEnv()).toEqual([{ name: 'valid', key: 'ok' }]);
  });
});

describe('ApiKeyService.importLegacyKeyForSA', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('is idempotent — second import returns the existing row', async () => {
    const a = await ctx.svc.importLegacyKeyForSA(
      'org_main',
      ctx.saId,
      'legacy-1',
      'verysecret',
    );
    const b = await ctx.svc.importLegacyKeyForSA(
      'org_main',
      ctx.saId,
      'legacy-1',
      'verysecret',
    );
    expect(a.id).toBe(b.id);
  });

  it('stored key is the SHA-256 of the legacy plaintext', async () => {
    const row = await ctx.svc.importLegacyKeyForSA(
      'org_main',
      ctx.saId,
      'x',
      'opaque',
    );
    const expected = createHash('sha256').update('opaque').digest('hex');
    expect(row.key).toBe(expected);
  });
});

describe('ApiKeyService quota', () => {
  it('rejects when env QUOTA_API_KEYS_PER_SA exceeded', async () => {
    const ctx = await build();
    const svc = new ApiKeyService(
      {
        apiKeys: ctx.apiKeys,
        users: ctx.users,
        orgUsers: ctx.orgUsers,
        audit: new AuditWriter(ctx.audit),
      },
      { QUOTA_API_KEYS_PER_SA: '1' },
    );
    await svc.issueServiceAccountToken('org_main', ctx.saId, { name: 'a' });
    await expect(
      svc.issueServiceAccountToken('org_main', ctx.saId, { name: 'b' }),
    ).rejects.toBeInstanceOf(ApiKeyServiceError);
  });
});
