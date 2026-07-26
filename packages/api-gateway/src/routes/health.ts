import { Router } from 'express';
import type { Request, Response } from 'express';

export const healthRouter = Router();

// Pipeline running state - updated by proactive-pipeline-runner after start
let pipelineRunning = false;
export function setPipelineRunning(value: boolean): void {
  pipelineRunning = value;
}

const startedAt = Date.now();

/**
 * How readiness finds out whether the database answers.
 *
 * Registered by the persistence wiring rather than imported, so this router
 * keeps its no-dependency shape — the same reason `setPipelineRunning` exists.
 */
let probeDatabase: (() => Promise<void>) | null = null;
export function setDatabaseProbe(probe: () => Promise<void>): void {
  probeDatabase = probe;
}

/** A hung database must not hold the probe open past the kubelet's patience. */
const DB_PROBE_TIMEOUT_MS = 2_000;

async function checkDb(): Promise<CheckResult> {
  if (!probeDatabase) {
    // Honest rather than reassuring: this used to claim "No DB configured",
    // which was false — persistence always builds SQLite or Postgres — and
    // resolved to healthy, so a pod with an unreachable database stayed in the
    // Service and kept taking traffic.
    return { status: 'skip', message: 'No database probe registered' };
  }
  try {
    await Promise.race([
      probeDatabase(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`no response in ${DB_PROBE_TIMEOUT_MS}ms`)), DB_PROBE_TIMEOUT_MS),
      ),
    ]);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'fail', message: err instanceof Error ? err.message : String(err) };
  }
}

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
healthRouter.get('/ready', async (_req: Request, res: Response) => {
  const db = await checkDb();
  // Redis genuinely is optional and unconfigured; unlike the database, that
  // claim is still true.
  const redis: CheckResult = { status: 'skip', message: 'No Redis configured' };
  const proactive = checkProactive();

  const checks = { db, redis, proactive };

  // K8s readiness answers "can this pod serve requests?". A pod that cannot
  // reach its database cannot, so it says so and Kubernetes takes it out of
  // the Service — previously every answer was 200 and a pod with a dead
  // database kept receiving traffic until someone noticed by hand.
  //
  // A failing proactive pipeline is different: the product still serves, it
  // just is not running background work. That stays 200 and reports degraded.
  const status: ReadyResponse['status']
    = db.status === 'fail' ? 'unhealthy'
    : proactive.status === 'fail' || db.status === 'skip' ? 'degraded'
    : 'healthy';

  res.status(status === 'unhealthy' ? 503 : 200).json({
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
