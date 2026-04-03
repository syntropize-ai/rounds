import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AlertRule, AlertSilence, NotificationPolicy } from '@agentic-obs/common';
import { defaultAlertRuleStore } from './alert-rule-store.js';
import { createLlmGateway } from './llm-factory.js';
import { AlertRuleAgent } from './dashboard/agents/alert-rule-agent.js';
import { getSetupConfig } from './setup.js';

const router = Router();

// -- POST /api/alert-rules/generate - NL -> alert rule (no dashboard needed)
// IMPORTANT: must be before /:id routes

router.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { prompt?: string };
    if (!body?.prompt || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'prompt is required' });
      return;
    }

    const config = getSetupConfig();
    if (!config.llm) {
      res.status(503).json({ code: 'LLM_NOT_CONFIGURED', message: 'LLM not configured - complete Setup Wizard first' });
      return;
    }

    const gateway = createLlmGateway(config.llm);
    const model = config.llm.model || 'claude-sonnet-4-6';

    const promDs = config.datasources.find((d) => d.type === 'prometheus' || d.type === 'victoria-metrics');
    const prometheusUrl = promDs?.url;
    const prometheusHeaders: Record<string, string> = {};

    if (promDs?.username && promDs?.password) {
      prometheusHeaders['Authorization'] = `Basic ${Buffer.from(`${promDs.username}:${promDs.password}`).toString('base64')}`;
    } else if (promDs?.apiKey) {
      prometheusHeaders['Authorization'] = `Bearer ${promDs.apiKey}`;
    }

    const agent = new AlertRuleAgent({ gateway, model, prometheusUrl, prometheusHeaders });
    const generated = await agent.generate(body.prompt.trim());

    const rule = defaultAlertRuleStore.create({
      name: generated.name,
      description: generated.description,
      originalPrompt: body.prompt.trim(),
      condition: generated.condition,
      evaluationIntervalSec: generated.evaluationIntervalSec,
      severity: generated.severity,
      labels: generated.labels,
      createdBy: 'llm',
      notificationPolicyId: undefined,
      autoInvestigate: generated.autoInvestigate,
    } as unknown as Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>);

    res.status(201).json(rule);
  } catch (err) {
    next(err);
  }
});

// -- Alert Rules CRUD

router.get('/', (req: Request, res: Response) => {
  const state = req.query['state'] as string | undefined;
  const severity = req.query['severity'] as string | undefined;
  const search = req.query['search'] as string | undefined;
  const limit = req.query['limit'] ? parseInt(req.query['limit'] as string) : undefined;
  const offset = req.query['offset'] ? parseInt(req.query['offset'] as string) : undefined;

  const results = defaultAlertRuleStore.findAll({
    state: state as AlertRule['state'] | undefined,
    severity,
    search,
    limit,
    offset,
  });

  res.json(results);
});

router.get('/:id', (req: Request, res: Response) => {
  const rule = defaultAlertRuleStore.findById(req.params['id'] ?? '');
  if (!rule) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
    return;
  }
  res.json(rule);
});

router.post('/', (req: Request, res: Response) => {
  const body = req.body as Partial<AlertRule>;
  if (!body?.name || !body.condition) {
    res.status(400).json({ code: 'INVALID_INPUT', message: 'name and condition are required' });
    return;
  }

  const rule = defaultAlertRuleStore.create({
    name: body.name,
    description: body.description ?? '',
    originalPrompt: body.originalPrompt,
    condition: body.condition,
    evaluationIntervalSec: body.evaluationIntervalSec ?? 60,
    severity: body.severity ?? 'medium',
    labels: body.labels ?? {},
    createdBy: body.createdBy ?? 'user',
    notificationPolicyId: body.notificationPolicyId,
  } as unknown as Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>);

  res.status(201).json(rule);
});

router.put('/:id', (req: Request, res: Response) => {
  const updated = defaultAlertRuleStore.update(req.params['id'] ?? '', req.body as Partial<AlertRule>);
  if (!updated) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
    return;
  }
  res.json(updated);
});

router.delete('/:id', (req: Request, res: Response) => {
  if (!defaultAlertRuleStore.delete(req.params['id'] ?? '')) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
    return;
  }
  res.status(204).end();
});

router.post('/:id/disable', (req: Request, res: Response) => {
  const rule = defaultAlertRuleStore.update(req.params['id'] ?? '', { state: 'disabled' as const });
  if (!rule) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
    return;
  }
  res.json(rule);
});

router.post('/:id/enable', (req: Request, res: Response) => {
  const rule = defaultAlertRuleStore.update(req.params['id'] ?? '', { state: 'normal' as const });
  if (!rule) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
    return;
  }
  res.json(rule);
});

router.get('/:id/history', (req: Request, res: Response) => {
  const limit = parseInt((req.query['limit'] as string | undefined) ?? '50', 10);
  res.json(defaultAlertRuleStore.getHistory(req.params['id'] ?? '', limit));
});

router.post('/:id/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = defaultAlertRuleStore.findById(req.params['id'] ?? '');
    if (!rule) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
      return;
    }

    // Placeholder - the actual PromQL evaluation will be wired in the pipeline.
    res.json({ ok: true, testResult: { message: 'Test endpoint ready - evaluator will be wired in pipeline' } });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/investigate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = defaultAlertRuleStore.findById(req.params['id'] ?? '');
    if (!rule) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Alert rule not found' });
      return;
    }

    const body = req.body as { force?: boolean } | undefined;

    if (rule.investigationId && !body?.force) {
      res.json({ investigationId: rule.investigationId, existing: true });
      return;
    }

    const dashboardStoreModule = await import('./dashboard/store.js');
    const dashboard = dashboardStoreModule.defaultDashboardStore.create({
      title: `Investigation for alert ${rule.name}`,
      description: `Investigation for alert: ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold}`,
      prompt: '',
      userId: 'alert-system',
      datasourceIds: [],
      useExistingMetrics: true,
    });

    defaultAlertRuleStore.update(rule.id, { investigationId: dashboard.id });

    res.json({ investigationId: dashboard.id, prompt: 'investigatePrompt', existing: false });
  } catch (err) {
    next(err);
  }
});

// -- Silences

router.get('/silences/all', (_req: Request, res: Response) => {
  res.json(defaultAlertRuleStore.findAllSilencesIncludingExpired());
});

router.get('/silences', (_req: Request, res: Response) => {
  res.json(defaultAlertRuleStore.findSilences());
});

router.post('/silences', (req: Request, res: Response) => {
  const body = req.body as Partial<AlertSilence>;
  if (!body?.matchers || !body?.startsAt || !body?.endsAt) {
    res.status(400).json({ code: 'INVALID_INPUT', message: 'matchers, startsAt, endsAt are required' });
    return;
  }

  const silence = defaultAlertRuleStore.createSilence({
    matchers: body.matchers,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    comment: body.comment ?? '',
    createdBy: body.createdBy ?? 'user',
  } as Omit<AlertSilence, 'id' | 'createdAt'>);

  res.status(201).json(silence);
});

router.put('/silences/:id', (req: Request, res: Response) => {
  const updated = defaultAlertRuleStore.updateSilence(req.params['id'] ?? '', req.body as Partial<AlertSilence>);
  if (!updated) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Silence not found' });
    return;
  }
  res.json(updated);
});

router.delete('/silences/:id', (req: Request, res: Response) => {
  if (!defaultAlertRuleStore.deleteSilence(req.params['id'] ?? '')) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Silence not found' });
    return;
  }
  res.status(204).end();
});

// -- Notification Policies

router.get('/notification-policies', (_req: Request, res: Response) => {
  res.json(defaultAlertRuleStore.findAllPolicies());
});

router.post('/notification-policies', (req: Request, res: Response) => {
  const body = req.body as Partial<NotificationPolicy>;
  if (!body?.name || !body?.channels) {
    res.status(400).json({ code: 'INVALID_INPUT', message: 'name and channels are required' });
    return;
  }

  const policy = defaultAlertRuleStore.createPolicy({
    name: body.name,
    matchers: body.matchers ?? [],
    channels: body.channels,
    groupBy: body.groupBy ?? [],
    groupWaitSec: body.groupWaitSec ?? 30,
    groupIntervalSec: body.groupIntervalSec ?? 300,
    repeatIntervalSec: body.repeatIntervalSec ?? 3600,
  } as Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>);

  res.status(201).json(policy);
});

router.put('/notification-policies/:id', (req: Request, res: Response) => {
  const updated = defaultAlertRuleStore.updatePolicy(req.params['id'] ?? '', req.body as Partial<NotificationPolicy>);
  if (!updated) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Notification policy not found' });
    return;
  }
  res.json(updated);
});

router.delete('/notification-policies/:id', (req: Request, res: Response) => {
  if (!defaultAlertRuleStore.deletePolicy(req.params['id'] ?? '')) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Notification policy not found' });
    return;
  }
  res.status(204).end();
});

export { router as alertRulesRouter };
