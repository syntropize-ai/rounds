import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-support/test-db.js';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { SqliteDashboardVariableAckRepository } from './dashboard-variable-ack.js';

describe('SqliteDashboardVariableAckRepository', () => {
  let db: SqliteClient;
  let repo: SqliteDashboardVariableAckRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteDashboardVariableAckRepository(db);
  });

  it('findAck returns null when no row exists', async () => {
    expect(await repo.findAck('u1', 'd1', 'h1')).toBeNull();
  });

  it('ackVariables inserts a row that findAck returns', async () => {
    await repo.ackVariables({ orgId: 'org_main', userId: 'u1', dashboardUid: 'd1', varsHash: 'h1' });
    const row = await repo.findAck('u1', 'd1', 'h1');
    expect(row).not.toBeNull();
    expect(row!.userId).toBe('u1');
    expect(row!.dashboardUid).toBe('d1');
    expect(row!.varsHash).toBe('h1');
    expect(row!.orgId).toBe('org_main');
  });

  it('ackVariables is idempotent on (user, dashboard, hash)', async () => {
    const first = await repo.ackVariables({ orgId: 'org_main', userId: 'u1', dashboardUid: 'd1', varsHash: 'h1' });
    const second = await repo.ackVariables({ orgId: 'org_main', userId: 'u1', dashboardUid: 'd1', varsHash: 'h1' });
    expect(second.id).toBe(first.id);
    expect(second.ackedAt).toBe(first.ackedAt);
  });

  it('distinguishes acks by hash', async () => {
    await repo.ackVariables({ orgId: 'org_main', userId: 'u1', dashboardUid: 'd1', varsHash: 'h1' });
    expect(await repo.findAck('u1', 'd1', 'h1')).not.toBeNull();
    expect(await repo.findAck('u1', 'd1', 'h2')).toBeNull();
  });

  it('distinguishes acks by user', async () => {
    await repo.ackVariables({ orgId: 'org_main', userId: 'u1', dashboardUid: 'd1', varsHash: 'h1' });
    expect(await repo.findAck('u2', 'd1', 'h1')).toBeNull();
  });

  it('clearAcksForDashboard removes every row for that dashboard', async () => {
    await repo.ackVariables({ orgId: 'org_main', userId: 'u1', dashboardUid: 'd1', varsHash: 'h1' });
    await repo.ackVariables({ orgId: 'org_main', userId: 'u2', dashboardUid: 'd1', varsHash: 'h2' });
    await repo.ackVariables({ orgId: 'org_main', userId: 'u1', dashboardUid: 'd2', varsHash: 'h1' });
    await repo.clearAcksForDashboard('d1');
    expect(await repo.findAck('u1', 'd1', 'h1')).toBeNull();
    expect(await repo.findAck('u2', 'd1', 'h2')).toBeNull();
    // unrelated dashboard untouched
    expect(await repo.findAck('u1', 'd2', 'h1')).not.toBeNull();
  });
});
