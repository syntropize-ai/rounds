/**
 * Tests for the W6/T6.A2 `InvestigationRepository`.
 *
 * Covers the full public surface of the in-memory `InvestigationStore`
 * that this repository replaces:
 *   - create + findById
 *   - findAll (with and without tenant filter)
 *   - findByWorkspace filter (ignores archived)
 *   - updateStatus / updatePlan / updateResult
 *   - follow-up add/list (empty array when none)
 *   - feedback add/list
 *   - conclusion get/set (null when absent, upsert on set)
 *   - archive / restoreFromArchive / getArchived
 *   - delete (cascades to sub-entities)
 *   - missing lookups return null (not undefined)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { InvestigationRepository } from './investigation.js';

describe('InvestigationRepository (W6/T6.A2)', () => {
  let db: SqliteClient;
  let repo: InvestigationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new InvestigationRepository(db);
  });

  // -- Primary entity -------------------------------------------------

  describe('create + findById', () => {
    it('create returns the inserted investigation and findById round-trips it', async () => {
      const inv = await repo.create({
        question: 'Why is latency up?',
        sessionId: 'sess-1',
        userId: 'user-1',
      });
      expect(inv.id).toMatch(/^inv_/);
      expect(inv.intent).toBe('Why is latency up?');
      expect(inv.status).toBe('planning');
      expect(inv.hypotheses).toEqual([]);
      expect(inv.evidence).toEqual([]);
      expect(inv.actions).toEqual([]);
      expect(inv.symptoms).toEqual([]);
      expect(inv.plan).toEqual({
        entity: '',
        objective: 'Why is latency up?',
        steps: [],
        stopConditions: [],
      });

      const fetched = await repo.findById(inv.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(inv.id);
      expect(fetched!.intent).toBe('Why is latency up?');
    });

    it('findById returns null (not undefined) when the id is missing', async () => {
      const res = await repo.findById('inv_does_not_exist');
      expect(res).toBeNull();
    });

    it('create respects optional workspaceId, tenantId, entity, timeRange', async () => {
      const tr = { start: '2026-04-22T00:00:00.000Z', end: '2026-04-22T01:00:00.000Z' };
      const inv = await repo.create({
        question: 'Q',
        sessionId: 'sess-x',
        userId: 'user-x',
        entity: 'checkout-service',
        timeRange: tr,
        tenantId: 'tenant-a',
        workspaceId: 'ws-1',
      });
      expect(inv.workspaceId).toBe('ws-1');
      expect(inv.structuredIntent.entity).toBe('checkout-service');
      expect(inv.structuredIntent.timeRange).toEqual(tr);
      expect(inv.plan.entity).toBe('checkout-service');
    });
  });

  // -- findAll / findByWorkspace --------------------------------------

  describe('findAll + findByWorkspace', () => {
    it('findAll returns all non-archived investigations; tenant filter narrows them', async () => {
      const a = await repo.create({ question: 'a', sessionId: 's', userId: 'u', tenantId: 't1' });
      const b = await repo.create({ question: 'b', sessionId: 's', userId: 'u', tenantId: 't1' });
      const c = await repo.create({ question: 'c', sessionId: 's', userId: 'u', tenantId: 't2' });

      const all = await repo.findAll();
      expect(all.map((i) => i.id).sort()).toEqual([a.id, b.id, c.id].sort());

      const t1Only = await repo.findAll('t1');
      expect(t1Only.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

      const t2Only = await repo.findAll('t2');
      expect(t2Only.map((i) => i.id)).toEqual([c.id]);
    });

    it('findAll hides archived investigations', async () => {
      const a = await repo.create({ question: 'a', sessionId: 's', userId: 'u' });
      await repo.create({ question: 'b', sessionId: 's', userId: 'u' });
      await repo.archive(a.id);

      const all = await repo.findAll();
      expect(all.map((i) => i.id).includes(a.id)).toBe(false);
      expect(all).toHaveLength(1);
    });

    it('findByWorkspace returns only the matching workspace rows and skips archived', async () => {
      const a = await repo.create({
        question: 'a', sessionId: 's', userId: 'u', workspaceId: 'ws-1',
      });
      const b = await repo.create({
        question: 'b', sessionId: 's', userId: 'u', workspaceId: 'ws-2',
      });
      const c = await repo.create({
        question: 'c', sessionId: 's', userId: 'u', workspaceId: 'ws-1',
      });
      await repo.archive(c.id);

      const ws1 = await repo.findByWorkspace('ws-1');
      expect(ws1.map((i) => i.id)).toEqual([a.id]);
      const ws2 = await repo.findByWorkspace('ws-2');
      expect(ws2.map((i) => i.id)).toEqual([b.id]);
      const wsNone = await repo.findByWorkspace('ws-missing');
      expect(wsNone).toEqual([]);
    });
  });

  // -- Write-backs ----------------------------------------------------

  describe('updateStatus / updatePlan / updateResult', () => {
    it('updateStatus changes the status and bumps updatedAt', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      const createdAt = inv.updatedAt;
      // Make sure clocks advance at least a millisecond.
      await new Promise((r) => setTimeout(r, 5));
      const updated = await repo.updateStatus(inv.id, 'investigating');
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('investigating');
      expect(updated!.updatedAt >= createdAt).toBe(true);
    });

    it('updateStatus returns null when the id is missing', async () => {
      const res = await repo.updateStatus('inv_missing', 'completed');
      expect(res).toBeNull();
    });

    it('updatePlan persists the plan JSON and round-trips', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      const plan = {
        entity: 'api-gateway',
        objective: 'investigate spike',
        steps: [
          { id: 'step-1', type: 'query', description: 'pull metrics', status: 'pending' as const },
        ],
        stopConditions: [
          { type: 'max_cost' as const, params: { usd: 1 } },
        ],
      };
      const updated = await repo.updatePlan(inv.id, plan);
      expect(updated).not.toBeNull();
      expect(updated!.plan).toEqual(plan);

      // Re-read to make sure JSON is persisted round-trip.
      const fetched = await repo.findById(inv.id);
      expect(fetched!.plan).toEqual(plan);
    });

    it('updateResult writes hypotheses/evidence and upserts conclusion', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      const hypotheses = [
        {
          id: 'h1',
          investigationId: inv.id,
          description: 'DB connection pool exhausted',
          confidence: 0.8,
          confidenceBasis: 'metric spike',
          evidenceIds: ['e1'],
          counterEvidenceIds: [],
          status: 'supported' as const,
        },
      ];
      const evidence: never[] = [];
      const conclusion = {
        summary: 'pool',
        rootCause: 'DB pool',
        confidence: 0.8,
        recommendedActions: ['scale pool'],
      };

      const updated = await repo.updateResult(inv.id, {
        hypotheses,
        evidence,
        conclusion,
      });
      expect(updated).not.toBeNull();
      expect(updated!.hypotheses).toEqual(hypotheses);

      const gotConclusion = await repo.getConclusion(inv.id);
      expect(gotConclusion).toEqual(conclusion);
    });

    it('updateResult with null conclusion does not write to investigation_conclusions', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      await repo.updateResult(inv.id, { hypotheses: [], evidence: [], conclusion: null });
      expect(await repo.getConclusion(inv.id)).toBeNull();
    });
  });

  // -- Follow-ups -----------------------------------------------------

  describe('follow-ups', () => {
    it('getFollowUps returns [] for an investigation with none', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      expect(await repo.getFollowUps(inv.id)).toEqual([]);
    });

    it('addFollowUp appends records and getFollowUps returns them in insertion order', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      const f1 = await repo.addFollowUp(inv.id, 'why?');
      // Ensure insertion ordering for timestamp-based sort is deterministic.
      await new Promise((r) => setTimeout(r, 5));
      const f2 = await repo.addFollowUp(inv.id, 'what next?');
      const list = await repo.getFollowUps(inv.id);
      expect(list).toHaveLength(2);
      expect(list[0]!.id).toBe(f1.id);
      expect(list[0]!.question).toBe('why?');
      expect(list[1]!.id).toBe(f2.id);
      expect(list[1]!.question).toBe('what next?');
      expect(list[0]!.investigationId).toBe(inv.id);
    });
  });

  // -- Feedback -------------------------------------------------------

  describe('feedback', () => {
    it('listFeedback returns [] when none recorded', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      expect(await repo.listFeedback(inv.id)).toEqual([]);
    });

    it('addFeedback stores and listFeedback reads back; booleans, JSON arrays round-trip', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
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

      const list = await repo.listFeedback(inv.id);
      expect(list).toHaveLength(1);
      const row = list[0]!;
      expect(row.helpful).toBe(true);
      expect(row.comment).toBe('nice');
      expect(row.rootCauseVerdict).toBe('correct');
      expect(row.hypothesisFeedbacks).toHaveLength(2);
      expect(row.hypothesisFeedbacks![1]!.verdict).toBe('wrong');
      expect(row.actionFeedbacks).toEqual([{ actionId: 'a1', helpful: true }]);
    });

    it('addFeedback with minimal body (helpful only) stores nulls for optional fields', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      const stored = await repo.addFeedback(inv.id, { helpful: false });
      expect(stored.helpful).toBe(false);
      expect(stored.comment).toBeUndefined();
      expect(stored.rootCauseVerdict).toBeUndefined();
      expect(stored.hypothesisFeedbacks).toBeUndefined();
      expect(stored.actionFeedbacks).toBeUndefined();
      const list = await repo.listFeedback(inv.id);
      expect(list[0]!.helpful).toBe(false);
    });
  });

  // -- Conclusions ----------------------------------------------------

  describe('conclusions', () => {
    it('getConclusion returns null when no conclusion is recorded', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      expect(await repo.getConclusion(inv.id)).toBeNull();
    });

    it('setConclusion upserts — first write creates, second overwrites', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
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
  });

  // -- Archive flow ---------------------------------------------------

  describe('archive flow', () => {
    it('archive flips the flag; findAll/findByWorkspace skip it but findById still returns it', async () => {
      const inv = await repo.create({
        question: 'q', sessionId: 's', userId: 'u', workspaceId: 'ws-1',
      });
      const archived = await repo.archive(inv.id);
      expect(archived).not.toBeNull();
      expect(archived!.id).toBe(inv.id);

      expect(await repo.findAll()).toHaveLength(0);
      expect(await repo.findByWorkspace('ws-1')).toHaveLength(0);

      // findById still returns the row (old store behavior: findById also
      // looked in the archive map).
      const byId = await repo.findById(inv.id);
      expect(byId).not.toBeNull();
      expect(byId!.id).toBe(inv.id);
    });

    it('getArchived lists only archived rows', async () => {
      const a = await repo.create({ question: 'a', sessionId: 's', userId: 'u' });
      const b = await repo.create({ question: 'b', sessionId: 's', userId: 'u' });
      await repo.archive(a.id);
      const archived = await repo.getArchived();
      expect(archived.map((i) => i.id)).toEqual([a.id]);
      // b still active
      expect((await repo.findAll()).map((i) => i.id)).toEqual([b.id]);
    });

    it('restoreFromArchive moves a row back into the active set; returns null if not archived', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      // Not archived yet → restore is a no-op returning null.
      expect(await repo.restoreFromArchive(inv.id)).toBeNull();
      await repo.archive(inv.id);
      const restored = await repo.restoreFromArchive(inv.id);
      expect(restored).not.toBeNull();
      expect(restored!.id).toBe(inv.id);
      expect(await repo.getArchived()).toHaveLength(0);
      expect(await repo.findAll()).toHaveLength(1);
    });

    it('archive returns null for a missing id', async () => {
      expect(await repo.archive('inv_missing')).toBeNull();
    });
  });

  // -- Delete ---------------------------------------------------------

  describe('delete', () => {
    it('delete removes the investigation and cascades to follow-ups/feedback/conclusions', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      await repo.addFollowUp(inv.id, 'fu?');
      await repo.addFeedback(inv.id, { helpful: true });
      await repo.setConclusion(inv.id, {
        summary: 's', rootCause: null, confidence: 0, recommendedActions: [],
      });

      expect(await repo.delete(inv.id)).toBe(true);
      expect(await repo.findById(inv.id)).toBeNull();
      expect(await repo.getFollowUps(inv.id)).toEqual([]);
      expect(await repo.listFeedback(inv.id)).toEqual([]);
      expect(await repo.getConclusion(inv.id)).toBeNull();
    });

    it('delete returns false for a missing id', async () => {
      expect(await repo.delete('inv_missing')).toBe(false);
    });

    it('delete also cleans up an archived investigation', async () => {
      const inv = await repo.create({ question: 'q', sessionId: 's', userId: 'u' });
      await repo.archive(inv.id);
      expect(await repo.delete(inv.id)).toBe(true);
      expect(await repo.findById(inv.id)).toBeNull();
    });
  });
});
