import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { UserAuthTokenRepository } from './user-auth-token-repository.js';
import { UserRepository } from './user-repository.js';

describe('UserAuthTokenRepository', () => {
  let db: SqliteClient;
  let repo: UserAuthTokenRepository;
  let userId: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new UserAuthTokenRepository(db);
    const userRepo = new UserRepository(db);
    const u = await userRepo.create({
      email: 't@x.test', name: 'T', login: 'token_owner', orgId: 'org_main',
    });
    userId = u.id;
  });

  it('create() stores a hashed token', async () => {
    const t = await repo.create({
      userId,
      authToken: 'sha256_abc',
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
    });
    expect(t.authToken).toBe('sha256_abc');
    expect(t.authTokenSeen).toBe(false);
    expect(t.revokedAt).toBeNull();
  });

  it('findByHashedToken() returns live token by current hash', async () => {
    const t = await repo.create({
      userId, authToken: 'live_hash', userAgent: 'x', clientIp: '1.2.3.4',
    });
    expect((await repo.findByHashedToken('live_hash'))!.id).toBe(t.id);
  });

  it('findByHashedToken() also accepts the prev_auth_token during rotation grace window', async () => {
    const t = await repo.create({
      userId, authToken: 'old_hash', userAgent: 'x', clientIp: '1.2.3.4',
    });
    await repo.rotate(t.id, 'new_hash', '2026-04-17T00:00:00.000Z');
    expect((await repo.findByHashedToken('old_hash'))!.id).toBe(t.id);
    expect((await repo.findByHashedToken('new_hash'))!.id).toBe(t.id);
  });

  it('findByHashedToken() returns null for revoked tokens', async () => {
    const t = await repo.create({
      userId, authToken: 'rev_hash', userAgent: 'x', clientIp: '1.2.3.4',
    });
    await repo.revoke(t.id, '2026-04-17T00:00:00.000Z');
    expect(await repo.findByHashedToken('rev_hash')).toBeNull();
  });

  it('listByUser() hides revoked by default', async () => {
    const a = await repo.create({
      userId, authToken: 'a', userAgent: 'x', clientIp: '1.2.3.4',
    });
    await repo.create({
      userId, authToken: 'b', userAgent: 'x', clientIp: '1.2.3.4',
    });
    await repo.revoke(a.id, '2026-04-17T00:00:00.000Z');
    const live = await repo.listByUser(userId);
    expect(live.map((t) => t.authToken)).toEqual(['b']);
    const all = await repo.listByUser(userId, true);
    expect(all).toHaveLength(2);
  });

  it('markSeen() sets the seen flag + timestamp', async () => {
    const t = await repo.create({
      userId, authToken: 's', userAgent: 'x', clientIp: '1.2.3.4',
    });
    await repo.markSeen(t.id, '2026-04-17T00:10:00.000Z');
    const found = await repo.findById(t.id);
    expect(found!.authTokenSeen).toBe(true);
    expect(found!.seenAt).toBe('2026-04-17T00:10:00.000Z');
  });

  it('rotate() moves current to prev and sets new', async () => {
    const t = await repo.create({
      userId, authToken: 'h1', userAgent: 'x', clientIp: '1.2.3.4',
    });
    const updated = await repo.rotate(t.id, 'h2', '2026-04-17T01:00:00.000Z');
    expect(updated!.authToken).toBe('h2');
    expect(updated!.prevAuthToken).toBe('h1');
    expect(updated!.rotatedAt).toBe('2026-04-17T01:00:00.000Z');
  });

  it('revokeAllForUser() revokes every active token', async () => {
    await repo.create({ userId, authToken: 'a', userAgent: 'x', clientIp: '1.2.3.4' });
    await repo.create({ userId, authToken: 'b', userAgent: 'x', clientIp: '1.2.3.4' });
    const n = await repo.revokeAllForUser(userId, '2026-04-17T00:00:00.000Z');
    expect(n).toBe(2);
    expect(await repo.listByUser(userId)).toHaveLength(0);
  });

  it('deleteExpired() prunes rows older than cutoff', async () => {
    await repo.create({ userId, authToken: 'x1', userAgent: 'x', clientIp: '1.2.3.4' });
    const n = await repo.deleteExpired('2099-01-01T00:00:00.000Z');
    expect(n).toBe(1);
  });

  it('cascade deletes tokens when user is deleted', async () => {
    await repo.create({ userId, authToken: 'cx', userAgent: 'x', clientIp: '1.2.3.4' });
    const userRepo = new UserRepository(db);
    await userRepo.delete(userId);
    expect(await repo.listByUser(userId, true)).toHaveLength(0);
  });
});
