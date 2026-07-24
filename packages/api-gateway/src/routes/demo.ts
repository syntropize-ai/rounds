// Demo-mode routes — only mounted when ROUNDS_DEMO=1 (or legacy
// OPENOBS_DEMO=1) is set in the env.
//
// Goals:
//   - Surface a public `GET /api/demo/status` so the web UI can render a
//     "Demo mode" banner and the "Try investigation" CTA.
//   - Surface `GET /api/demo/investigation` returning the preset
//     investigation fixture (deterministic — no real LLM call).
//   - Surface `GET /api/demo/alert-rule` so the CTA can deep-link.
//
// The router is INTENTIONALLY trivial. All wiring happens behind the
// explicit env-var gate in server.ts; this module never reads env on its
// own and so cannot be silently enabled.

import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { QueryClient } from '@agentic-obs/data-layer';
import type { Evidence, Hypothesis, Investigation } from '@agentic-obs/common';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixtures live under /demo/fixtures at the repo root. After `npm run dist`
// the bundled CLI ships them next to the server bundle. We try a few
// resolution candidates so source-tree dev and the published npm package
// both work.
function loadFixture(name: string): unknown {
  const candidates = [
    // Source tree: packages/api-gateway/dist/routes/demo.js -> ../../../../demo/fixtures
    join(__dirname, '../../../../demo/fixtures', name),
    // ts-node / tsx: packages/api-gateway/src/routes/demo.ts -> same up
    join(__dirname, '../../../../demo/fixtures', name),
    // Published npm bundle: dist/server.mjs -> ./demo/fixtures
    join(__dirname, '../demo/fixtures', name),
    join(__dirname, './demo/fixtures', name),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // try next
    }
  }
  throw new Error(`demo fixture '${name}' not found in any candidate path`);
}

/** Investigation id advertised by `GET /status` and used by the boot seed. */
export const DEMO_INVESTIGATION_ID = 'demo-investigation-api-latency';

/** Demo instances are single-org; the UI reads investigations of `org_main`. */
const DEMO_ORG_ID = 'org_main';

interface InvestigationFixture {
  title: string;
  summary: string;
  rootCause: string;
  evidence: Array<{
    kind: Evidence['type'];
    label: string;
    query: string;
    value: number;
    unit: string;
  }>;
}

/**
 * Idempotently insert the fixture investigation the demo banner CTA links
 * to (`/investigations/<DEMO_INVESTIGATION_ID>`). Without it the CTA lands
 * on "Investigation not found".
 *
 * Called from the ROUNDS_DEMO gate in server.ts — this module never reads
 * env, so a non-demo boot never seeds anything. `IInvestigationRepository`
 * mints its own ids, so the row goes in through the raw query client to
 * pin the exact id `GET /status` advertises.
 */
export async function seedDemoInvestigation(db: QueryClient): Promise<void> {
  const existing = await db.all<{ id: string }>(
    sql`SELECT id FROM investigations WHERE id = ${DEMO_INVESTIGATION_ID}`,
  );
  if (existing.length > 0) return;

  const fixture = loadFixture('investigation.json') as InvestigationFixture;
  const now = new Date().toISOString();
  const start = new Date(Date.now() - 3600_000).toISOString();
  const hypothesisId = `${DEMO_INVESTIGATION_ID}-h1`;

  const evidence: Evidence[] = fixture.evidence.map((e, i) => ({
    id: `${DEMO_INVESTIGATION_ID}-e${i + 1}`,
    hypothesisId,
    type: e.kind,
    query: e.query,
    queryLanguage: 'promql',
    result: { value: e.value, unit: e.unit },
    summary: e.label,
    timestamp: now,
    reproducible: true,
  }));

  const hypotheses: Hypothesis[] = [
    {
      id: hypothesisId,
      investigationId: DEMO_INVESTIGATION_ID,
      description: fixture.rootCause,
      confidence: 0.9,
      confidenceBasis: fixture.summary,
      evidenceIds: evidence.map((e) => e.id),
      counterEvidenceIds: [],
      status: 'supported',
    },
  ];

  const structuredIntent: Investigation['structuredIntent'] = {
    taskType: 'explain_latency',
    entity: 'api-server-0',
    timeRange: { start, end: now },
    goal: fixture.title,
  };
  const plan: Investigation['plan'] = {
    entity: 'api-server-0',
    objective: fixture.title,
    steps: [],
    stopConditions: [],
  };

  await db.run(sql`
    INSERT INTO investigations (
      id, org_id, tenant_id, session_id, user_id, intent,
      structured_intent, plan, status,
      hypotheses, actions, evidence, symptoms,
      workspace_id, archived,
      created_at, updated_at
    ) VALUES (
      ${DEMO_INVESTIGATION_ID},
      ${DEMO_ORG_ID},
      ${''},
      ${'demo'},
      ${'demo'},
      ${fixture.title},
      ${JSON.stringify(structuredIntent)},
      ${JSON.stringify(plan)},
      ${'completed'},
      ${JSON.stringify(hypotheses)},
      ${'[]'},
      ${JSON.stringify(evidence)},
      ${'[]'},
      ${DEMO_ORG_ID},
      ${0},
      ${now},
      ${now}
    )
  `);
}

export interface DemoStatus {
  enabled: true;
  banner: string;
  cta: { label: string; investigationId: string };
}

export function createDemoRouter(): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    const status: DemoStatus = {
      enabled: true,
      banner: 'Demo mode — fixture data only. No real cluster is connected.',
      cta: {
        label: 'Try investigation: API latency spike',
        investigationId: DEMO_INVESTIGATION_ID,
      },
    };
    res.json(status);
  });

  router.get('/investigation', (_req, res) => {
    res.json(loadFixture('investigation.json'));
  });

  router.get('/alert-rule', (_req, res) => {
    res.json(loadFixture('alert-rule.json'));
  });

  return router;
}
