/**
 * Tests for the generic KB entries CRUD route (unified skill-style shape).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type {
  IKnowledgeRepository,
  KnowledgeEntry,
  KnowledgeInsertInput,
  KnowledgePatch,
} from '@agentic-obs/common';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

// Per-test toggle for the auth middleware mock.
const authState = { authed: true };

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    if (authState.authed) {
      req.auth = {
        userId: 'user_1',
        orgId: 'org_main',
        orgRole: 'Admin',
        isServerAdmin: false,
        authenticatedBy: 'session',
      };
    }
    next();
  },
}));

// Import AFTER the mock declaration so the route uses the mocked middleware.
import { createKbEntriesRouter } from './kb-entries.js';

function inMemoryKbRepo(): IKnowledgeRepository {
  const rows = new Map<string, KnowledgeEntry>();
  const key = (orgId: string, id: string) => `${orgId}::${id}`;
  const repo: IKnowledgeRepository = {
    async insert(input: KnowledgeInsertInput) {
      const now = new Date().toISOString();
      const entry: KnowledgeEntry = {
        ...input,
        useCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(key(input.orgId, input.id), entry);
      return entry;
    },
    async getById(orgId, id) {
      return rows.get(key(orgId, id)) ?? null;
    },
    async list(orgId, opts) {
      const out: KnowledgeEntry[] = [];
      for (const [k, v] of rows) {
        if (!k.startsWith(`${orgId}::`)) continue;
        if (opts?.source && v.source !== opts.source) continue;
        out.push(v);
      }
      return opts?.limit ? out.slice(0, opts.limit) : out;
    },
    async update(orgId, id, patch: KnowledgePatch) {
      const cur = rows.get(key(orgId, id));
      if (!cur) return null;
      const next: KnowledgeEntry = {
        ...cur,
        title: patch.title ?? cur.title,
        description: patch.description ?? cur.description,
        body: patch.body ?? cur.body,
        intentTags: patch.intentTags ?? cur.intentTags,
        sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : cur.sourceRef,
        updatedAt: new Date().toISOString(),
      };
      rows.set(key(orgId, id), next);
      return next;
    },
    async bumpUseCount() {},
    async recordFeedback() {},
    async delete(orgId, id) {
      rows.delete(key(orgId, id));
    },
    async listForSearch(orgId, opts) {
      return repo.list(orgId, opts);
    },
  };
  return repo;
}

function makeAc(opts: { allowWrite?: boolean; allowRead?: boolean } = {}): AccessControlSurface {
  const allowWrite = opts.allowWrite ?? true;
  const allowRead = opts.allowRead ?? true;
  return {
    evaluate: vi.fn(async (_id, evaluator) => {
      const s = evaluator.string();
      if (s.startsWith('dashboards:create')) return allowWrite;
      if (s.startsWith('chat:use')) return allowRead;
      return true;
    }),
    filterByPermission: vi.fn(async (_id, items) => [...items]),
  } as unknown as AccessControlSurface;
}

function buildApp(knowledge: IKnowledgeRepository, accessControl: AccessControlSurface) {
  const app = express();
  app.use(express.json());
  app.use('/api/kb/entries', createKbEntriesRouter({ knowledge, accessControl }));
  return app;
}

async function seed(repo: IKnowledgeRepository, overrides: Partial<KnowledgeInsertInput> = {}): Promise<KnowledgeEntry> {
  return repo.insert({
    id: overrides.id ?? `e-${Math.random().toString(36).slice(2)}`,
    orgId: overrides.orgId ?? 'org_main',
    source: overrides.source ?? 'saved',
    sourceRef: overrides.sourceRef ?? null,
    title: overrides.title ?? 'sample',
    description: overrides.description ?? 'sample description',
    body: overrides.body ?? '',
    intentTags: overrides.intentTags ?? [],
    createdBy: overrides.createdBy ?? null,
  });
}

describe('kb-entries route', () => {
  let knowledge: IKnowledgeRepository;

  beforeEach(() => {
    authState.authed = true;
    knowledge = inMemoryKbRepo();
  });

  describe('GET /api/kb/entries', () => {
    it('returns 200 with empty list when no entries', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).get('/api/kb/entries');
      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
    });

    it('filters by source=bundled', async () => {
      await seed(knowledge, { id: 'b1', source: 'bundled' });
      await seed(knowledge, { id: 's1', source: 'saved' });
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).get('/api/kb/entries?source=bundled');
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].id).toBe('b1');
    });

    it('rejects ?kind= with 400 (kind is no longer supported)', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).get('/api/kb/entries?kind=template');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/kind is no longer supported/);
    });
  });

  describe('GET /api/kb/entries/:id', () => {
    it('returns 200 with the entry', async () => {
      const e = await seed(knowledge, { id: 'e-known' });
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).get(`/api/kb/entries/${e.id}`);
      expect(res.status).toBe(200);
      expect(res.body.entry.id).toBe('e-known');
    });

    it('returns 404 for unknown id', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).get('/api/kb/entries/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/kb/entries', () => {
    it('returns 201 + entry; forces source to "saved"', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .post('/api/kb/entries')
        .send({
          title: 'My skill',
          description: 'Picks the right exporter for latency dashboards',
          body: '# How to use\n\nDo X then Y.',
          intentTags: ['latency'],
          // client lies about source — must be ignored.
          source: 'bundled',
        });
      expect(res.status).toBe(201);
      expect(res.body.entry.source).toBe('saved');
      expect(res.body.entry.title).toBe('My skill');
      expect(res.body.entry.description).toBe('Picks the right exporter for latency dashboards');
      expect(res.body.entry.body).toBe('# How to use\n\nDo X then Y.');
    });

    it('defaults body to empty string when omitted', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .post('/api/kb/entries')
        .send({ title: 't', description: 'd', intentTags: [] });
      expect(res.status).toBe(201);
      expect(res.body.entry.body).toBe('');
    });

    it('returns 400 when title is missing', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .post('/api/kb/entries')
        .send({ description: 'd', body: '', intentTags: [] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when description is missing', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .post('/api/kb/entries')
        .send({ title: 't', body: '', intentTags: [] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when kind is present (kind is removed)', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .post('/api/kb/entries')
        .send({ title: 't', description: 'd', kind: 'pattern', intentTags: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/kind is no longer supported/);
    });

    it('returns 409 when id starts with "bundled-"', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .post('/api/kb/entries')
        .send({
          id: 'bundled-foo',
          title: 't',
          description: 'd',
          body: '',
          intentTags: [],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BUNDLED_NAMESPACE');
    });

    it('returns 403 when caller lacks dashboards:create', async () => {
      const app = buildApp(knowledge, makeAc({ allowWrite: false }));
      const res = await request(app)
        .post('/api/kb/entries')
        .send({ title: 't', description: 'd', body: '', intentTags: [] });
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/kb/entries/:id', () => {
    it('returns 200 and applies title/description/body/intentTags', async () => {
      const e = await seed(knowledge, { id: 'e1', title: 'old', description: 'old desc', intentTags: ['a'] });
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .put(`/api/kb/entries/${e.id}`)
        .send({ title: 'new', description: 'new desc', body: 'new body', intentTags: ['b'] });
      expect(res.status).toBe(200);
      expect(res.body.entry.title).toBe('new');
      expect(res.body.entry.description).toBe('new desc');
      expect(res.body.entry.body).toBe('new body');
      expect(res.body.entry.intentTags).toEqual(['b']);
    });

    it('returns 403 BUNDLED_READONLY when entry is bundled', async () => {
      const e = await seed(knowledge, { id: 'b1', source: 'bundled' });
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .put(`/api/kb/entries/${e.id}`)
        .send({ title: 'nope' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('BUNDLED_READONLY');
    });

    it('returns 404 on unknown id', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .put('/api/kb/entries/nope')
        .send({ title: 'x' });
      expect(res.status).toBe(404);
    });

    it('returns 400 when kind is present (kind is removed)', async () => {
      const e = await seed(knowledge);
      const app = buildApp(knowledge, makeAc());
      const res = await request(app)
        .put(`/api/kb/entries/${e.id}`)
        .send({ kind: 'pattern' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/kb/entries/:id', () => {
    it('returns 204 and removes the entry', async () => {
      const e = await seed(knowledge, { id: 'd1' });
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).delete(`/api/kb/entries/${e.id}`);
      expect(res.status).toBe(204);
      expect(await knowledge.getById('org_main', e.id)).toBeNull();
    });

    it('returns 403 BUNDLED_READONLY for bundled entries', async () => {
      const e = await seed(knowledge, { id: 'b1', source: 'bundled' });
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).delete(`/api/kb/entries/${e.id}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('BUNDLED_READONLY');
    });

    it('returns 404 on unknown id', async () => {
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).delete('/api/kb/entries/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('auth', () => {
    it('returns 401 when not authenticated', async () => {
      authState.authed = false;
      const app = buildApp(knowledge, makeAc());
      const res = await request(app).get('/api/kb/entries');
      expect(res.status).toBe(401);
    });
  });
});
