/**
 * Postgres InvestigationRepository — round-trip integration tests.
 *
 * Guarded by `POSTGRES_TEST_URL`. When the env var is absent the entire
 * suite `describe.skip`s so CI stays green without a Postgres container.
 *
 * Each test truncates the investigation tables in `beforeEach` to isolate
 * state. Cascade ordering is implicit via the `RESTART IDENTITY CASCADE`
 * clause.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../db/client.js';
import { applyPostgresInstanceMigrations } from './migrate.js';
import { PostgresInvestigationRepository } from './investigation.js';
import type { Investigation } from '@agentic-obs/common';

const PG_URL = process.env['POSTGRES_TEST_URL'];
const describeIfPg = PG_URL ? describe : describe.skip;

function emptyInvestigationInput(overrides: Partial<Investigation> = {}): Omit<
  Investigation,
  'id' | 'createdAt'
> {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    intent: 'Why is latency up?',
    structuredIntent: {
      taskType: 'general_query',
      entity: '',
      timeRange: { start: '', end: '' },
      goal: 'Why is latency up?',
    },
    plan: { entity: '', objective: 'Why is latency up?', steps: [], stopConditions: [] },
    status: 'planning',
    hypotheses: [],
    evidence: [],
    symptoms: [],
    actions: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Omit<Investigation, 'id' | 'createdAt'>;
}

describeIfPg('PostgresInvestigationRepository', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = createDbClient({ url: PG_URL! });
    await applyPostgresInstanceMigrations(db);
  });

  beforeEach(async () => {
    // Truncate children explicitly + parent with CASCADE for safety.
    await db.execute(sql`
      TRUNCATE
        investigation_conclusions,
        investigation_feedback,
        investigation_follow_ups,
        investigations
      RESTART IDENTITY CASCADE
    `);
  });

  // -- Primary entity ---------------------------------------------------

  it('create + findById round-trips actions and workspaceId', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const inv = await repo.create(
      emptyInvestigationInput({
        actions: [
          { id: 'a1', type: 'restart', target: 'svc', status: 'pending' } as never,
        ],
        workspaceId: 'ws-1',
      }),
    );
    expect(inv.id).toMatch(/^inv_/);
    expect(inv.actions).toHaveLength(1);
    expect(inv.workspaceId).toBe('ws-1');

    const fetched = await repo.findById(inv.id);
    expect(fetched).toBeDefined();
    expect(fetched!.actions).toHaveLength(1);
    expect(fetched!.workspaceId).toBe('ws-1');
  });

  it('findByWorkspace returns matching rows and skips archived', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const a = await repo.create(emptyInvestigationInput({ workspaceId: 'ws-1' }));
    const b = await repo.create(emptyInvestigationInput({ workspaceId: 'ws-2' }));
    const c = await repo.create(emptyInvestigationInput({ workspaceId: 'ws-1' }));
    await repo.archive(c.id);

    const ws1 = await repo.findByWorkspace('ws-1');
    expect(ws1.map((i) => i.id)).toEqual([a.id]);

    const ws2 = await repo.findByWorkspace('ws-2');
    expect(ws2.map((i) => i.id)).toEqual([b.id]);

    expect(await repo.findByWorkspace('ws-missing')).toEqual([]);
  });

  // -- Follow-ups -------------------------------------------------------

  it('addFollowUp persists and getFollowUps returns rows in insertion order', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const inv = await repo.create(emptyInvestigationInput());

    expect(await repo.getFollowUps(inv.id)).toEqual([]);

    const f1 = await repo.addFollowUp(inv.id, 'why?');
    await new Promise((r) => setTimeout(r, 5));
    const f2 = await repo.addFollowUp(inv.id, 'what next?');

    const list = await repo.getFollowUps(inv.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(f1.id);
    expect(list[0]!.question).toBe('why?');
    expect(list[1]!.id).toBe(f2.id);
    expect(list[1]!.question).toBe('what next?');
  });

  // -- Feedback ---------------------------------------------------------

  it('addFeedback round-trips booleans and JSON arrays', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const inv = await repo.create(emptyInvestigationInput());

    const stored = await repo.addFeedback(inv.id, {
      helpful: true,
      comment: 'nice',
      rootCauseVerdict: 'correct',
      hypothesisFeedbacks: [
        { hypothesisId: 'h1', verdict: 'correct' },
        { hypothesisId: 'h2', verdict: 'wrong', comment: 'nope' },
      ],
      actionFeedbacks: [{ actionId: 'a1', helpful: true }],
    });
    expect(stored.id).toMatch(/^fb_/);
    expect(stored.investigationId).toBe(inv.id);
    expect(stored.helpful).toBe(true);
    expect(stored.comment).toBe('nice');
    expect(stored.rootCauseVerdict).toBe('correct');
    expect(stored.hypothesisFeedbacks).toHaveLength(2);
    expect(stored.hypothesisFeedbacks![1]!.verdict).toBe('wrong');
    expect(stored.actionFeedbacks).toEqual([{ actionId: 'a1', helpful: true }]);
  });

  it('addFeedback with minimal body stores nulls for optional fields', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const inv = await repo.create(emptyInvestigationInput());
    const stored = await repo.addFeedback(inv.id, { helpful: false });
    expect(stored.helpful).toBe(false);
    expect(stored.comment).toBeUndefined();
    expect(stored.rootCauseVerdict).toBeUndefined();
    expect(stored.hypothesisFeedbacks).toBeUndefined();
    expect(stored.actionFeedbacks).toBeUndefined();
  });

  // -- Conclusions ------------------------------------------------------

  it('getConclusion returns undefined when none recorded', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const inv = await repo.create(emptyInvestigationInput());
    expect(await repo.getConclusion(inv.id)).toBeUndefined();
  });

  it('setConclusion upserts — first write creates, second overwrites', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const inv = await repo.create(emptyInvestigationInput());

    await repo.setConclusion(inv.id, {
      summary: 'first',
      rootCause: 'rc1',
      confidence: 0.5,
      recommendedActions: ['x'],
    });
    expect((await repo.getConclusion(inv.id))!.summary).toBe('first');

    await repo.setConclusion(inv.id, {
      summary: 'second',
      rootCause: 'rc2',
      confidence: 0.9,
      recommendedActions: ['y', 'z'],
    });
    const got = await repo.getConclusion(inv.id);
    expect(got!.summary).toBe('second');
    expect(got!.recommendedActions).toEqual(['y', 'z']);
  });

  // -- Cascade ----------------------------------------------------------

  it('delete cascades to follow-ups, feedback and conclusions', async () => {
    const repo = new PostgresInvestigationRepository(db);
    const inv = await repo.create(emptyInvestigationInput());
    await repo.addFollowUp(inv.id, 'q?');
    await repo.addFeedback(inv.id, { helpful: true });
    await repo.setConclusion(inv.id, {
      summary: 's',
      rootCause: null,
      confidence: 0,
      recommendedActions: [],
    });

    expect(await repo.delete(inv.id)).toBe(true);
    expect(await repo.findById(inv.id)).toBeUndefined();
    expect(await repo.getFollowUps(inv.id)).toEqual([]);
    expect(await repo.getConclusion(inv.id)).toBeUndefined();
  });
});
