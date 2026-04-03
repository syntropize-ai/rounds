import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { ApiError, IncidentSeverity, IncidentStatus } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  incidentStore,
  defaultInvestigationStore,
  postMortemStore as postmortemStore,
  type CreateIncidentParams,
  type UpdateIncidentParams,
} from '@agentic-obs/data-layer';
import type { PostMortemInput, PostMortemReport } from '@agentic-obs/agent-core';
import type { IGatewayIncidentStore } from '../repositories/types.js';
import { getWorkspaceId } from '../middleware/workspace-context.js';

const VALID_STATUSES: IncidentStatus[] = ['open', 'mitigated', 'resolved'];
const VALID_SEVERITIES: IncidentSeverity[] = ['P1', 'P2', 'P3', 'P4'];

// -- Post-mortem generator interface (injectable for testing)
export interface PostMortemGeneratorDep {
  generate(input: PostMortemInput): Promise<PostMortemReport>;
}

export interface IncidentRouterExtras {
  pmStore?: typeof postmortemStore;
  generator?: PostMortemGeneratorDep;
}

export function createIncidentRouter(
  store: IGatewayIncidentStore = incidentStore,
  extras: IncidentRouterExtras = {},
): Router {
  const router = Router();
  router.use(authMiddleware);

  const pmStore = extras.pmStore ?? postmortemStore;
  const generator = extras.generator;

  // POST /api/incidents - create
  router.post('/', requirePermission('incident:create'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as Partial<CreateIncidentParams>;

      if (typeof body?.title !== 'string' || !body.title.trim()) {
        const err: ApiError = { code: 'INVALID_INPUT', message: 'title is required and must be a non-empty string' };
        res.status(400).json(err);
        return;
      }

      if (body.severity && !VALID_SEVERITIES.includes(body.severity)) {
        const err: ApiError = { code: 'INVALID_INPUT', message: `severity must be one of ${VALID_SEVERITIES.join(', ')}` };
        res.status(400).json(err);
        return;
      }

      if (body.services && !Array.isArray(body.services)) {
        const err: ApiError = { code: 'INVALID_INPUT', message: 'services must be an array of strings' };
        res.status(400).json(err);
        return;
      }

      const workspaceId = getWorkspaceId(req);
      const incident = await store.create({
        title: body.title.trim(),
        severity: body.severity ?? 'P3',
        services: body.services,
        assignee: typeof body.assignee === 'string' ? body.assignee : undefined,
        workspaceId,
      });

      res.status(201).json(incident);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/incidents/archived - list archived incidents before /:id to avoid shadowing
  router.get('/archived', requirePermission('incident:read'), async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await store.getArchived());
    } catch (err) {
      next(err);
    }
  });

  // POST /api/incidents/archived/:id/restore - restore archived incident
  router.post('/archived/:id/restore', requirePermission('incident:write'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const inc = await store.restoreFromArchive(req.params['id'] ?? '');
      if (!inc) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Archived incident not found' };
        res.status(404).json(err);
        return;
      }
      res.json(inc);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/incidents - list all
  router.get('/', requirePermission('incident:read'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId = getWorkspaceId(req);
      const all = (await store.findAll()).filter((inc) => (inc.workspaceId ?? 'default') === workspaceId).map((inc) => ({
        id: inc.id,
        title: inc.title,
        severity: inc.severity,
        status: inc.status,
        serviceIds: inc.serviceIds,
        investigationCount: inc.investigationIds.length,
        createdAt: inc.createdAt,
        updatedAt: inc.updatedAt,
        resolvedAt: inc.resolvedAt,
      }));
      res.json(all);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/incidents/:id - get single
  router.get('/:id', requirePermission('incident:read'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const incident = await store.findById(req.params['id'] ?? '');
      if (!incident) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Incident not found' };
        res.status(404).json(err);
        return;
      }
      const workspaceId = getWorkspaceId(req);
      if ((incident.workspaceId ?? 'default') !== workspaceId) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Incident not found' };
        res.status(404).json(err);
        return;
      }
      res.json(incident);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/incidents/:id - update
  router.patch('/:id', requirePermission('incident:create'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await store.findById(req.params['id'] ?? ''))) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Incident not found' };
        res.status(404).json(err);
        return;
      }

      const body = req.body as Partial<UpdateIncidentParams>;

      if (body.status !== undefined && !VALID_STATUSES.includes(body.status as IncidentStatus)) {
        const err: ApiError = { code: 'INVALID_INPUT', message: `status must be one of ${VALID_STATUSES.join(', ')}` };
        res.status(400).json(err);
        return;
      }

      if (body.severity !== undefined && !VALID_SEVERITIES.includes(body.severity as IncidentSeverity)) {
        const err: ApiError = { code: 'INVALID_INPUT', message: `severity must be one of ${VALID_SEVERITIES.join(', ')}` };
        res.status(400).json(err);
        return;
      }

      const updated = await store.update(req.params['id'] ?? '', body);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/incidents/:id/investigations - link investigation
  router.post('/:id/investigations', requirePermission('incident:create'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params['id'] ?? '';
      if (!(await store.findById(id))) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Incident not found' };
        res.status(404).json(err);
        return;
      }

      const { investigationId } = req.body as { investigationId?: string };
      if (!investigationId || typeof investigationId !== 'string') {
        const err: ApiError = { code: 'INVALID_INPUT', message: 'investigationId is required' };
        res.status(400).json(err);
        return;
      }

      const updated = await store.addInvestigation(id, investigationId);
      res.status(201).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/incidents/:id/timeline - get timeline
  router.get('/:id/timeline', requirePermission('incident:read'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const timeline = await store.getTimeline(req.params['id'] ?? '');
      if (timeline === undefined) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Incident not found' };
        res.status(404).json(err);
        return;
      }
      res.json({ incidentId: req.params['id'], timeline });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/incidents/:id/post-mortem - generate (or re-generate) post-mortem report
  router.post('/:id/post-mortem', requirePermission('incident:read'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params['id'] ?? '';
      const incident = await store.findById(id);
      if (!incident) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Incident not found' };
        res.status(404).json(err);
        return;
      }

      // Return cached report unless force=true
      const body = req.body as { force?: boolean; executionResults?: unknown[]; verificationOutcomes?: unknown[] } | undefined;
      if (!body?.force && pmStore.has(id)) {
        res.json(pmStore.get(id));
        return;
      }

      if (!generator) {
        const err: ApiError = { code: 'SERVICE_UNAVAILABLE', message: 'Post-mortem generator is not configured' };
        res.status(503).json(err);
        return;
      }

      // Build investigation data from linked investigation IDs
      const investigations = incident.investigationIds
        .map((invId) => defaultInvestigationStore.findById(invId))
        .filter(Boolean)
        .map((inv) => ({
          id: inv!.id,
          intents: inv!.intent,
          status: inv!.status,
          conclusionSummary: (inv as any).conclusion?.summary ?? '',
          hypotheses: inv!.hypotheses.map((h) => ({
            description: h.description,
            confidence: h.confidence,
          })),
          evidence: inv!.evidence.map((e: any) => ({
            type: e.type,
            summary: e.summary,
          })),
        }));

      const input: PostMortemInput = {
        incident: {
          id: incident.id,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          services: incident.serviceIds,
          createdAt: incident.createdAt,
          resolvedAt: incident.resolvedAt,
          timeline: incident.timeline.map((e) => ({
            type: e.type,
            description: e.description,
            timestamp: e.timestamp,
          })),
        },
        investigations,
        executionResults: Array.isArray(body?.executionResults) ? body!.executionResults as PostMortemInput['executionResults'] : [],
        verificationOutcomes: Array.isArray(body?.verificationOutcomes) ? body!.verificationOutcomes as PostMortemInput['verificationOutcomes'] : [],
      };

      const report = await generator.generate(input);
      pmStore.set(id, report);
      res.status(201).json(report);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/incidents/:id/post-mortem - retrieve existing post-mortem report
  router.get('/:id/post-mortem', requirePermission('incident:read'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params['id'] ?? '';
      if (!(await store.findById(id))) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Incident not found' };
        res.status(404).json(err);
        return;
      }

      const report = pmStore.get(id);
      if (!report) {
        const err: ApiError = { code: 'NOT_FOUND', message: 'Post-mortem report not yet generated. Use POST to generate one.' };
        res.status(404).json(err);
        return;
      }

      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const incidentRouter = createIncidentRouter();
