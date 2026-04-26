/**
 * ServiceAccountService unit tests — T6.1.
 *
 * Fixture scenarios mirror docs/auth-perm-design/06-service-accounts.md
 * §test-scenarios 1, 7, 10, 11 (create, delete, SA login guard, quota).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuditLogRepository,
  ApiKeyRepository,
  OrgUserRepository,
  QuotaRepository,
  TeamMemberRepository,
  UserRepository,
  UserRoleRepository,
  createTestDb,
  seedDefaultOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { AuditWriter } from '../auth/audit-writer.js';
import {
  ServiceAccountService,
  ServiceAccountServiceError,
  slugify,
} from './serviceaccount-service.js';

interface Ctx {
  db: SqliteClient;
  users: UserRepository;
  orgUsers: OrgUserRepository;
  apiKeys: ApiKeyRepository;
  service: ServiceAccountService;
  auditRepo: AuditLogRepository;
  adminId: string;
}

async function build(env: NodeJS.ProcessEnv = {}): Promise<Ctx> {
  const db = createTestDb();
  await seedDefaultOrg(db);
  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const userRoles = new UserRoleRepository(db);
  const teamMembers = new TeamMemberRepository(db);
  const quotas = new QuotaRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const audit = new AuditWriter(auditRepo);

  const adminUser = await users.create({
    email: 'admin@t.local',
    name: 'Admin',
    login: 'admin',
    orgId: 'org_main',
    isAdmin: true,
  });
  await orgUsers.create({ orgId: 'org_main', userId: adminUser.id, role: 'Admin' });

  const service = new ServiceAccountService({
    users,
    orgUsers,
    apiKeys,
    userRoles,
    teamMembers,
    quotas,
    audit,
    env,
  });
  return { db, users, orgUsers, apiKeys, service, auditRepo, adminId: adminUser.id };
}

describe('ServiceAccountService.slugify', () => {
  it('lowercases and dash-joins words', () => {
    expect(slugify('Grafana Prom Scraper')).toBe('grafana-prom-scraper');
  });
  it('strips non-alphanumerics', () => {
    expect(slugify('My SA!!!')).toBe('my-sa');
  });
  it('collapses repeated separators', () => {
    expect(slugify('  a  b  ')).toBe('a-b');
  });
  it('falls back to sa when empty', () => {
    expect(slugify('---')).toBe('sa');
  });
});

describe('ServiceAccountService.create', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('creates a user row with is_service_account=1', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'Prometheus',
      role: 'Viewer',
    });
    expect(sa.name).toBe('Prometheus');
    expect(sa.role).toBe('Viewer');
    expect(sa.login).toBe('sa-prometheus');
    const user = await ctx.users.findById(sa.id);
    expect(user?.isServiceAccount).toBe(true);
    expect(user?.isAdmin).toBe(false);
  });

  it('creates matching org_user membership with supplied role', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'Editor Bot',
      role: 'Editor',
    });
    const m = await ctx.orgUsers.findMembership('org_main', sa.id);
    expect(m?.role).toBe('Editor');
  });

  it('appends a counter on login collision', async () => {
    const a = await ctx.service.create('org_main', ctx.adminId, {
      name: 'Scraper',
      role: 'Viewer',
    });
    const b = await ctx.service.create('org_main', ctx.adminId, {
      name: 'Scraper',
      role: 'Viewer',
    });
    expect(a.login).toBe('sa-scraper');
    expect(b.login).toBe('sa-scraper-2');
  });

  it('rejects blank name (400)', async () => {
    await expect(
      ctx.service.create('org_main', ctx.adminId, { name: '', role: 'Viewer' }),
    ).rejects.toMatchObject({ kind: 'validation', statusCode: 400 });
  });

  it('rejects invalid role (400)', async () => {
    await expect(
      ctx.service.create('org_main', ctx.adminId, {
        name: 'x',
        role: 'NotARole' as unknown as 'Viewer',
      }),
    ).rejects.toBeInstanceOf(ServiceAccountServiceError);
  });

  it('writes an audit log row (serviceaccount.created)', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'Audited',
      role: 'Viewer',
    });
    // AuditWriter is fire-and-forget; wait a tick.
    await new Promise((r) => setTimeout(r, 10));
    const rows = await ctx.auditRepo.query({ action: 'serviceaccount.created' });
    expect(rows.items.some((r) => r.targetId === sa.id)).toBe(true);
  });

  it('enforces quota from QUOTA_SERVICE_ACCOUNTS_PER_ORG env', async () => {
    const ctx2 = await build({ QUOTA_SERVICE_ACCOUNTS_PER_ORG: '2' });
    // seed both via env ctx
    await ctx2.service.create('org_main', ctx2.adminId, {
      name: 'a',
      role: 'Viewer',
    });
    await ctx2.service.create('org_main', ctx2.adminId, {
      name: 'b',
      role: 'Viewer',
    });
    await expect(
      ctx2.service.create('org_main', ctx2.adminId, {
        name: 'c',
        role: 'Viewer',
      }),
    ).rejects.toMatchObject({ kind: 'quota_exceeded', statusCode: 403 });
  });

  it('enforces quota from quota row when present', async () => {
    const quotas = new QuotaRepository(ctx.db);
    await quotas.upsertOrgQuota('org_main', 'service_accounts', 1);
    await ctx.service.create('org_main', ctx.adminId, {
      name: 'first',
      role: 'Viewer',
    });
    await expect(
      ctx.service.create('org_main', ctx.adminId, {
        name: 'second',
        role: 'Viewer',
      }),
    ).rejects.toMatchObject({ kind: 'quota_exceeded' });
  });

  it('allows unlimited when no env/quota set', async () => {
    for (let i = 0; i < 5; i += 1) {
      await ctx.service.create('org_main', ctx.adminId, {
        name: `sa-${i}`,
        role: 'Viewer',
      });
    }
    const list = await ctx.service.list('org_main');
    expect(list.total).toBe(5);
  });
});

describe('ServiceAccountService.list/get/update', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('returns null for a user that is not an SA', async () => {
    const sa = await ctx.service.getById('org_main', ctx.adminId);
    expect(sa).toBeNull();
  });

  it('returns SA scoped to the correct org', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'Bot',
      role: 'Viewer',
    });
    const found = await ctx.service.getById('org_main', sa.id);
    expect(found?.id).toBe(sa.id);
  });

  it('lists SAs with a search query', async () => {
    await ctx.service.create('org_main', ctx.adminId, {
      name: 'alpha',
      role: 'Viewer',
    });
    await ctx.service.create('org_main', ctx.adminId, {
      name: 'beta',
      role: 'Viewer',
    });
    const page = await ctx.service.list('org_main', { query: 'alp' });
    expect(page.items.length).toBe(1);
    expect(page.items[0]?.name).toBe('alpha');
  });

  it('updates name/role/isDisabled', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'X',
      role: 'Viewer',
    });
    const updated = await ctx.service.update('org_main', sa.id, ctx.adminId, {
      name: 'X2',
      role: 'Editor',
      isDisabled: true,
    });
    expect(updated.name).toBe('X2');
    expect(updated.role).toBe('Editor');
    expect(updated.isDisabled).toBe(true);
  });

  it('update 404 on non-SA', async () => {
    await expect(
      ctx.service.update('org_main', ctx.adminId, ctx.adminId, {
        name: 'hacker',
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('ServiceAccountService.delete', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('deletes the SA user row', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'Doomed',
      role: 'Viewer',
    });
    await ctx.service.delete('org_main', sa.id, ctx.adminId);
    const user = await ctx.users.findById(sa.id);
    expect(user).toBeNull();
  });

  it('hard-deletes the SA tokens alongside the SA', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'T',
      role: 'Viewer',
    });
    await ctx.apiKeys.create({
      orgId: 'org_main',
      name: 'k1',
      key: 'hash1',
      role: 'Viewer',
      serviceAccountId: sa.id,
    });
    await ctx.apiKeys.create({
      orgId: 'org_main',
      name: 'k2',
      key: 'hash2',
      role: 'Viewer',
      serviceAccountId: sa.id,
    });
    await ctx.service.delete('org_main', sa.id, ctx.adminId);
    const page = await ctx.apiKeys.list({
      orgId: 'org_main',
      serviceAccountId: sa.id,
      includeRevoked: true,
    });
    expect(page.total).toBe(0);
  });

  it('audit log on delete', async () => {
    const sa = await ctx.service.create('org_main', ctx.adminId, {
      name: 'L',
      role: 'Viewer',
    });
    await ctx.service.delete('org_main', sa.id, ctx.adminId);
    await new Promise((r) => setTimeout(r, 10));
    const rows = await ctx.auditRepo.query({ action: 'serviceaccount.deleted' });
    expect(rows.items.some((r) => r.targetId === sa.id)).toBe(true);
  });

  it('delete 404 on unknown id', async () => {
    await expect(
      ctx.service.delete('org_main', 'u_missing', ctx.adminId),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});
