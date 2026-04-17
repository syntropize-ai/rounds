import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { UserRepository } from './user-repository.js';
import { UserAuthRepository } from './user-auth-repository.js';

describe('UserRepository', () => {
  let db: SqliteClient;
  let repo: UserRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new UserRepository(db);
  });

  it('create() inserts a user row', async () => {
    const u = await repo.create({
      email: 'alice@example.test',
      name: 'Alice',
      login: 'alice',
      orgId: 'org_main',
    });
    expect(u.login).toBe('alice');
    expect(u.isAdmin).toBe(false);
    expect(u.isServiceAccount).toBe(false);
  });

  it('create() with isAdmin=true sets server admin flag', async () => {
    const u = await repo.create({
      email: 'admin@example.test',
      name: 'Admin',
      login: 'admin',
      orgId: 'org_main',
      isAdmin: true,
    });
    expect(u.isAdmin).toBe(true);
  });

  it('findByLogin() resolves by login', async () => {
    await repo.create({ email: 'l@x.test', name: 'L', login: 'loggy', orgId: 'org_main' });
    const u = await repo.findByLogin('loggy');
    expect(u).not.toBeNull();
    expect(u!.login).toBe('loggy');
  });

  it('findByEmail() resolves by email', async () => {
    await repo.create({ email: 'em@x.test', name: 'E', login: 'emily', orgId: 'org_main' });
    expect((await repo.findByEmail('em@x.test'))!.login).toBe('emily');
  });

  it('findByAuthInfo() joins user_auth and returns the linked user', async () => {
    const u = await repo.create({
      email: 'g@x.test', name: 'G', login: 'github_user', orgId: 'org_main',
    });
    const authRepo = new UserAuthRepository(db);
    await authRepo.create({
      userId: u.id,
      authModule: 'oauth_github',
      authId: '12345',
    });
    const found = await repo.findByAuthInfo('oauth_github', '12345');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(u.id);
  });

  it('findByAuthInfo() returns null when no binding exists', async () => {
    expect(await repo.findByAuthInfo('oauth_github', 'nope')).toBeNull();
  });

  it('list() paginates and filters by search term', async () => {
    for (const n of ['alpha', 'beta', 'gamma'])
      await repo.create({ email: `${n}@x.test`, name: n, login: n, orgId: 'org_main' });
    const page = await repo.list({ search: 'alph' });
    expect(page.items.map((u) => u.login)).toEqual(['alpha']);
  });

  it('list() can filter isServiceAccount=true', async () => {
    await repo.create({ email: 'h@x.test', name: 'H', login: 'human', orgId: 'org_main' });
    await repo.create({
      email: 's@x.test', name: 'S', login: 'sa_one', orgId: 'org_main', isServiceAccount: true,
    });
    const page = await repo.list({ isServiceAccount: true });
    expect(page.items.map((u) => u.login)).toEqual(['sa_one']);
  });

  it('update() mutates email and bumps version', async () => {
    const u = await repo.create({
      email: 'old@x.test', name: 'Old', login: 'old', orgId: 'org_main',
    });
    const updated = await repo.update(u.id, { email: 'new@x.test' });
    expect(updated!.email).toBe('new@x.test');
    expect(updated!.version).toBe(1);
  });

  it('setDisabled() toggles is_disabled', async () => {
    const u = await repo.create({
      email: 'd@x.test', name: 'D', login: 'disable', orgId: 'org_main',
    });
    await repo.setDisabled(u.id, true);
    expect((await repo.findById(u.id))!.isDisabled).toBe(true);
    await repo.setDisabled(u.id, false);
    expect((await repo.findById(u.id))!.isDisabled).toBe(false);
  });

  it('updateLastSeen() writes last_seen_at', async () => {
    const u = await repo.create({
      email: 's@x.test', name: 'S', login: 'seen', orgId: 'org_main',
    });
    await repo.updateLastSeen(u.id, '2026-04-17T00:00:00.000Z');
    expect((await repo.findById(u.id))!.lastSeenAt).toBe('2026-04-17T00:00:00.000Z');
  });

  it('countServiceAccounts() counts only SA rows for the org', async () => {
    await repo.create({ email: 'sa1@x.test', name: 'sa1', login: 'sa1', orgId: 'org_main', isServiceAccount: true });
    await repo.create({ email: 'sa2@x.test', name: 'sa2', login: 'sa2', orgId: 'org_main', isServiceAccount: true });
    await repo.create({ email: 'human@x.test', name: 'human', login: 'human', orgId: 'org_main' });
    expect(await repo.countServiceAccounts('org_main')).toBe(2);
  });

  it('delete() removes the row', async () => {
    const u = await repo.create({ email: 'z@x.test', name: 'Z', login: 'zzz', orgId: 'org_main' });
    expect(await repo.delete(u.id)).toBe(true);
    expect(await repo.findById(u.id)).toBeNull();
  });

  it('unique login index rejects duplicates', async () => {
    await repo.create({ email: 'u1@x.test', name: 'u1', login: 'dup', orgId: 'org_main' });
    await expect(
      repo.create({ email: 'u2@x.test', name: 'u2', login: 'dup', orgId: 'org_main' }),
    ).rejects.toThrow();
  });
});
