import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestDb,
  UserRepository,
  OrgUserRepository,
  type SqliteClient,
} from '@agentic-obs/data-layer';
import {
  seedAutoInvestigationSaIfNeeded,
  AUTO_INVESTIGATION_SA_LOGIN,
  AUTO_INVESTIGATION_SA_EMAIL,
} from './seed-auto-investigation-sa.js';

describe('seedAutoInvestigationSaIfNeeded', () => {
  let db: SqliteClient;
  let users: UserRepository;
  let orgUsers: OrgUserRepository;

  beforeEach(async () => {
    db = createTestDb();
    users = new UserRepository(db);
    orgUsers = new OrgUserRepository(db);
  });

  it('creates the SA user + org membership when missing', async () => {
    const id = await seedAutoInvestigationSaIfNeeded({ users, orgUsers });
    expect(id).not.toBeNull();
    const user = await users.findByLogin(AUTO_INVESTIGATION_SA_LOGIN);
    expect(user).not.toBeNull();
    expect(user!.isServiceAccount).toBe(true);
    expect(user!.email).toBe(AUTO_INVESTIGATION_SA_EMAIL);
    const member = await orgUsers.findMembership('org_main', user!.id);
    expect(member?.role).toBe('Editor');
  });

  it('is idempotent: a second run is a no-op', async () => {
    const id1 = await seedAutoInvestigationSaIfNeeded({ users, orgUsers });
    const id2 = await seedAutoInvestigationSaIfNeeded({ users, orgUsers });
    expect(id1).toBe(id2);
  });

  it('repairs missing org membership without recreating the user', async () => {
    const id = await seedAutoInvestigationSaIfNeeded({ users, orgUsers });
    expect(id).not.toBeNull();
    // Drop the org membership row directly to simulate a partial seed
    const member = await orgUsers.findMembership('org_main', id!);
    expect(member).not.toBeNull();
    await orgUsers.remove('org_main', id!);
    const after = await seedAutoInvestigationSaIfNeeded({ users, orgUsers });
    expect(after).toBe(id);
    const repaired = await orgUsers.findMembership('org_main', id!);
    expect(repaired?.role).toBe('Editor');
  });

  it('refuses to overwrite a non-SA user with login=openobs', async () => {
    await users.create({
      email: 'real@example.com',
      name: 'Real Person',
      login: AUTO_INVESTIGATION_SA_LOGIN,
      orgId: 'org_main',
      isAdmin: false,
      emailVerified: true,
    });
    const result = await seedAutoInvestigationSaIfNeeded({ users, orgUsers });
    expect(result).toBeNull();
    const user = await users.findByLogin(AUTO_INVESTIGATION_SA_LOGIN);
    expect(user!.isServiceAccount).toBe(false);
  });
});
