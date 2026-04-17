import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { UserAuthRepository } from './user-auth-repository.js';
import { UserRepository } from './user-repository.js';

describe('UserAuthRepository', () => {
  let db: SqliteClient;
  let repo: UserAuthRepository;
  let userId: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new UserAuthRepository(db);
    const userRepo = new UserRepository(db);
    const u = await userRepo.create({
      email: 'u@x.test', name: 'U', login: 'ua_owner', orgId: 'org_main',
    });
    userId = u.id;
  });

  it('create() inserts and populates tokens', async () => {
    const ua = await repo.create({
      userId,
      authModule: 'oauth_google',
      authId: 'gsub-123',
      oAuthAccessToken: 'enc_access',
      oAuthExpiry: 1700000000000,
    });
    expect(ua.authModule).toBe('oauth_google');
    expect(ua.oAuthAccessToken).toBe('enc_access');
    expect(ua.oAuthExpiry).toBe(1700000000000);
  });

  it('findById() returns the row', async () => {
    const ua = await repo.create({ userId, authModule: 'oauth_github', authId: '9' });
    expect((await repo.findById(ua.id))!.authId).toBe('9');
  });

  it('findByAuthInfo() returns the row', async () => {
    await repo.create({ userId, authModule: 'oauth_github', authId: '9' });
    expect((await repo.findByAuthInfo('oauth_github', '9'))!.userId).toBe(userId);
  });

  it('findByAuthInfo() returns null for unknown binding', async () => {
    expect(await repo.findByAuthInfo('saml', 'nope')).toBeNull();
  });

  it('listByUser() returns all bindings for a user', async () => {
    await repo.create({ userId, authModule: 'oauth_github', authId: 'g1' });
    await repo.create({ userId, authModule: 'oauth_google', authId: 'g2' });
    const out = await repo.listByUser(userId);
    expect(out).toHaveLength(2);
  });

  it('update() mutates tokens', async () => {
    const ua = await repo.create({ userId, authModule: 'oauth_github', authId: 'g1' });
    await repo.update(ua.id, { oAuthAccessToken: 'new' });
    expect((await repo.findById(ua.id))!.oAuthAccessToken).toBe('new');
  });

  it('delete() removes a single row', async () => {
    const ua = await repo.create({ userId, authModule: 'oauth_github', authId: 'g1' });
    expect(await repo.delete(ua.id)).toBe(true);
    expect(await repo.findById(ua.id)).toBeNull();
  });

  it('deleteByUser() removes all bindings for a user', async () => {
    await repo.create({ userId, authModule: 'oauth_github', authId: 'g1' });
    await repo.create({ userId, authModule: 'oauth_google', authId: 'g2' });
    const n = await repo.deleteByUser(userId);
    expect(n).toBe(2);
    expect(await repo.listByUser(userId)).toHaveLength(0);
  });

  it('unique (auth_module, auth_id) rejects duplicates', async () => {
    await repo.create({ userId, authModule: 'saml', authId: 's1' });
    await expect(
      repo.create({ userId, authModule: 'saml', authId: 's1' }),
    ).rejects.toThrow();
  });

  it('cascade deletes bindings when user is deleted', async () => {
    await repo.create({ userId, authModule: 'ldap', authId: 'cn=x' });
    const userRepo = new UserRepository(db);
    await userRepo.delete(userId);
    expect(await repo.listByUser(userId)).toHaveLength(0);
  });
});
