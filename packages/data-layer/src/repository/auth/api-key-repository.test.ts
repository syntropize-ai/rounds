import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { ApiKeyRepository } from './api-key-repository.js';
import { UserRepository } from './user-repository.js';

describe('ApiKeyRepository', () => {
  let db: SqliteClient;
  let repo: ApiKeyRepository;
  let saId: string;
  let ownerId: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new ApiKeyRepository(db);
    const userRepo = new UserRepository(db);
    const owner = await userRepo.create({
      email: 'o@x.test', name: 'O', login: 'owner', orgId: 'org_main',
    });
    const sa = await userRepo.create({
      email: 's@x.test', name: 'S', login: 'sa_akr', orgId: 'org_main', isServiceAccount: true,
    });
    ownerId = owner.id;
    saId = sa.id;
  });

  it('create() inserts a personal access token (service_account_id null)', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 'personal', key: 'sha256_a', role: 'Viewer', ownerUserId: ownerId,
    });
    expect(k.serviceAccountId).toBeNull();
    expect(k.ownerUserId).toBe(ownerId);
    expect(k.isRevoked).toBe(false);
  });

  it('create() inserts a service-account token', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 'sa-tok', key: 'sha256_b', role: 'Editor', serviceAccountId: saId,
    });
    expect(k.serviceAccountId).toBe(saId);
  });

  it('findByHashedKey() returns active key', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 't', key: 'sha256_c', role: 'Admin', serviceAccountId: saId,
    });
    expect((await repo.findByHashedKey('sha256_c'))!.id).toBe(k.id);
  });

  it('findByHashedKey() returns null for revoked keys', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 't', key: 'sha256_d', role: 'Admin', serviceAccountId: saId,
    });
    await repo.revoke(k.id);
    expect(await repo.findByHashedKey('sha256_d')).toBeNull();
  });

  it('list() filters by service account', async () => {
    await repo.create({
      orgId: 'org_main', name: 'sa1', key: 'sha256_sa1', role: 'A', serviceAccountId: saId,
    });
    await repo.create({
      orgId: 'org_main', name: 'pat', key: 'sha256_pat', role: 'A', ownerUserId: ownerId,
    });
    const saOnly = await repo.list({ serviceAccountId: saId });
    expect(saOnly.items.map((k) => k.name)).toEqual(['sa1']);
    const patOnly = await repo.list({ serviceAccountId: null });
    expect(patOnly.items.map((k) => k.name)).toEqual(['pat']);
  });

  it('list() hides revoked by default', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 'r', key: 'sha256_r', role: 'A', serviceAccountId: saId,
    });
    await repo.revoke(k.id);
    expect((await repo.list({ orgId: 'org_main' })).items).toHaveLength(0);
    expect(
      (await repo.list({ orgId: 'org_main', includeRevoked: true })).items,
    ).toHaveLength(1);
  });

  it('list() hides expired by default', async () => {
    await repo.create({
      orgId: 'org_main', name: 'exp', key: 'sha256_exp',
      role: 'A', serviceAccountId: saId, expires: '2000-01-01T00:00:00.000Z',
    });
    expect((await repo.list({ orgId: 'org_main' })).items).toHaveLength(0);
    expect(
      (await repo.list({ orgId: 'org_main', includeExpired: true })).items,
    ).toHaveLength(1);
  });

  it('update() mutates name and expires', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 'old', key: 'sha256_u', role: 'A', serviceAccountId: saId,
    });
    const updated = await repo.update(k.id, {
      name: 'new', expires: '2099-01-01T00:00:00.000Z',
    });
    expect(updated!.name).toBe('new');
    expect(updated!.expires).toBe('2099-01-01T00:00:00.000Z');
  });

  it('touchLastUsed() updates last_used_at', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 'tl', key: 'sha256_tl', role: 'A', serviceAccountId: saId,
    });
    await repo.touchLastUsed(k.id, '2026-04-17T00:00:00.000Z');
    expect((await repo.findById(k.id))!.lastUsedAt).toBe('2026-04-17T00:00:00.000Z');
  });

  it('delete() removes the row', async () => {
    const k = await repo.create({
      orgId: 'org_main', name: 'd', key: 'sha256_del', role: 'A', serviceAccountId: saId,
    });
    expect(await repo.delete(k.id)).toBe(true);
    expect(await repo.findById(k.id)).toBeNull();
  });

  it('unique key index rejects duplicates', async () => {
    await repo.create({
      orgId: 'org_main', name: 'k1', key: 'sha256_dup', role: 'A', serviceAccountId: saId,
    });
    await expect(
      repo.create({
        orgId: 'org_main', name: 'k2', key: 'sha256_dup', role: 'A', serviceAccountId: saId,
      }),
    ).rejects.toThrow();
  });
});
