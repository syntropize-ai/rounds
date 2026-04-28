import { Router } from 'express';
import type { Request, Response } from 'express';

export const healthRouter = Router();

// Pipeline running state - updated by proactive-pipeline-runner after start
let pipelineRunning = false;
export function setPipelineRunning(value: boolean): void {
  pipelineRunning = value;
}

const startedAt = Date.now();

type CheckStatus = 'ok' | 'fail' | 'skip';

interface CheckResult {
  status: CheckStatus;
  message?: string;
}

interface ReadyResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    db: CheckResult;
    redis: CheckResult;
    proactive: CheckResult;
  };
  timestamp: string;
}

function checkProactive(): CheckResult {
  return pipelineRunning
    ? { status: 'ok' }
    : { status: 'fail', message: 'Proactive pipeline not running' };
}

// GET /api/health/live - K8s liveness probe (simple alive check)
healthRouter.get('/live', (_req: Request, res: Response) => {
  res.json({ status: 'alive' });
});

// GET /api/health/startup - K8s startup probe (ready after brief warm-up)
healthRouter.get('/startup', (_req: Request, res: Response) => {
  const uptimeMs = Date.now() - startedAt;
  const WARM_UP_MS = 10_000;
  if (uptimeMs >= WARM_UP_MS) {
    res.json({ status: 'started', uptimeMs });
  }
  else {
    res.status(503).json({ status: 'starting', uptimeMs });
  }
});

// GET /api/health/ready - K8s readiness probe (deep dependency check)
healthRouter.get('/ready', (_req: Request, res: Response) => {
  // DB and Redis are not configured in this deployment (in-memory stores)
  const db: CheckResult = { status: 'skip', message: 'No DB configured' };
  const redis: CheckResult = { status: 'skip', message: 'No Redis configured' };
  const proactive = checkProactive();

  const checks = { db, redis, proactive };

  // K8s readiness should answer "can this pod receive traffic?". LLM setup is
  // handled by the login/setup flow, not by health checks.
  const status: ReadyResponse['status']
    = proactive.status === 'fail' ? 'degraded' : 'healthy';

  res.status(200).json({
    status,
    checks,
    timestamp: new Date().toISOString(),
  } satisfies ReadyResponse);
});

// GET /api/health - backward-compatible root check
healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});
