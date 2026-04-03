import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { incidentStore, } from './incident-store.js';
import { defaultInvestigationStore } from './investigation/store.js';
import { postMortemStore as postmortemStore } from './post-mortem-store.js';
const VALID_STATUSES = ['open', 'mitigated', 'resolved'];
const VALID_SEVERITIES = ['P1', 'P2', 'P3', 'P4'];
export function createIncidentRouter(store = incidentStore, extras = {}) {
    const router = Router();
    router.use(authMiddleware);
    const pmStore = extras.pmStore ?? postmortemStore;
    const generator = extras.generator;
    // POST /api/incidents - create
    router.post('/', requirePermission('incident:create'), async (req, res, next) => {
        try {
            const body = req.body;
            if (typeof body?.title !== 'string' || !body.title.trim()) {
                const err = { code: 'INVALID_INPUT', message: 'title is required and must be a non-empty string' };
                res.status(400).json(err);
                return;
            }
            if (body.severity && !VALID_SEVERITIES.includes(body.severity)) {
                const err = { code: 'INVALID_INPUT', message: `severity must be one of ${VALID_SEVERITIES.join(', ')}` };
                res.status(400).json(err);
                return;
            }
            if (body.services && !Array.isArray(body.services)) {
                const err = { code: 'INVALID_INPUT', message: 'services must be an array of strings' };
                res.status(400).json(err);
                return;
            }
            const incident = await store.create({
                title: body.title.trim(),
                severity: body.severity ?? 'P3',
                services: body.services,
                assignee: typeof body.assignee === 'string' ? body.assignee : undefined,
            });
            res.status(201).json(incident);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /api/incidents/archived - list archived incidents before /:id to avoid shadowing
    router.get('/archived', requirePermission('incident:read'), async (_req, res, next) => {
        try {
            res.json(await store.getArchived());
        }
        catch (err) {
            next(err);
        }
    });
    // POST /api/incidents/archived/:id/restore - restore archived incident
    router.post('/archived/:id/restore', requirePermission('incident:write'), async (req, res, next) => {
        try {
            const inc = await store.restoreFromArchive(req.params['id'] ?? '');
            if (!inc) {
                const err = { code: 'NOT_FOUND', message: 'Archived incident not found' };
                res.status(404).json(err);
                return;
            }
            res.json(inc);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /api/incidents - list all
    router.get('/', requirePermission('incident:read'), async (_req, res, next) => {
        try {
            const all = (await store.findAll()).map((inc) => ({
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
        }
        catch (err) {
            next(err);
        }
    });
    // GET /api/incidents/:id - get single
    router.get('/:id', requirePermission('incident:read'), async (req, res, next) => {
        try {
            const incident = await store.findById(req.params['id'] ?? '');
            if (!incident) {
                const err = { code: 'NOT_FOUND', message: 'Incident not found' };
                res.status(404).json(err);
                return;
            }
            res.json(incident);
        }
        catch (err) {
            next(err);
        }
    });
    // PATCH /api/incidents/:id - update
    router.patch('/:id', requirePermission('incident:create'), async (req, res, next) => {
        try {
            if (!(await store.findById(req.params['id'] ?? ''))) {
                const err = { code: 'NOT_FOUND', message: 'Incident not found' };
                res.status(404).json(err);
                return;
            }
            const body = req.body;
            if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
                const err = { code: 'INVALID_INPUT', message: `status must be one of ${VALID_STATUSES.join(', ')}` };
                res.status(400).json(err);
                return;
            }
            if (body.severity !== undefined && !VALID_SEVERITIES.includes(body.severity)) {
                const err = { code: 'INVALID_INPUT', message: `severity must be one of ${VALID_SEVERITIES.join(', ')}` };
                res.status(400).json(err);
                return;
            }
            const updated = await store.update(req.params['id'] ?? '', body);
            res.json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    // POST /api/incidents/:id/investigations - link investigation
    router.post('/:id/investigations', requirePermission('incident:create'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            if (!(await store.findById(id))) {
                const err = { code: 'NOT_FOUND', message: 'Incident not found' };
                res.status(404).json(err);
                return;
            }
            const { investigationId } = req.body;
            if (!investigationId || typeof investigationId !== 'string') {
                const err = { code: 'INVALID_INPUT', message: 'investigationId is required' };
                res.status(400).json(err);
                return;
            }
            const updated = await store.addInvestigation(id, investigationId);
            res.status(201).json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /api/incidents/:id/timeline - get timeline
    router.get('/:id/timeline', requirePermission('incident:read'), async (req, res, next) => {
        try {
            const timeline = await store.getTimeline(req.params['id'] ?? '');
            if (timeline === undefined) {
                const err = { code: 'NOT_FOUND', message: 'Incident not found' };
                res.status(404).json(err);
                return;
            }
            res.json({ incidentId: req.params['id'], timeline });
        }
        catch (err) {
            next(err);
        }
    });
    // POST /api/incidents/:id/post-mortem - generate (or re-generate) post-mortem report
    router.post('/:id/post-mortem', requirePermission('incident:read'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            const incident = await store.findById(id);
            if (!incident) {
                const err = { code: 'NOT_FOUND', message: 'Incident not found' };
                res.status(404).json(err);
                return;
            }
            // Return cached report unless force=true
            const body = req.body;
            if (!body?.force && pmStore.has(id)) {
                res.json(pmStore.get(id));
                return;
            }
            if (!generator) {
                const err = { code: 'SERVICE_UNAVAILABLE', message: 'Post-mortem generator is not configured' };
                res.status(503).json(err);
                return;
            }
            // Build investigation data from linked investigation IDs
            const investigations = incident.investigationIds
                .map((invId) => defaultInvestigationStore.findById(invId))
                .filter(Boolean)
                .map((inv) => ({
                id: inv.id,
                intents: inv.intent,
                status: inv.status,
                conclusionSummary: inv.conclusion?.summary ?? '',
                hypotheses: inv.hypotheses.map((h) => ({
                    description: h.description,
                    confidence: h.confidence,
                })),
                evidence: inv.evidence.map((e) => ({
                    type: e.type,
                    summary: e.summary,
                })),
            }));
            const input = {
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
                executionResults: Array.isArray(body?.executionResults) ? body.executionResults : [],
                verificationOutcomes: Array.isArray(body?.verificationOutcomes) ? body.verificationOutcomes : [],
            };
            const report = await generator.generate(input);
            pmStore.set(id, report);
            res.status(201).json(report);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /api/incidents/:id/post-mortem - retrieve existing post-mortem report
    router.get('/:id/post-mortem', requirePermission('incident:read'), async (req, res, next) => {
        try {
            const id = req.params['id'] ?? '';
            if (!(await store.findById(id))) {
                const err = { code: 'NOT_FOUND', message: 'Incident not found' };
                res.status(404).json(err);
                return;
            }
            const report = pmStore.get(id);
            if (!report) {
                const err = { code: 'NOT_FOUND', message: 'Post-mortem report not yet generated. Use POST to generate one.' };
                res.status(404).json(err);
                return;
            }
            res.json(report);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
export const incidentRouter = createIncidentRouter();
//# sourceMappingURL=incident.js.map