// Demo-mode routes — only mounted when OPENOBS_DEMO=1 is set in the env.
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
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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
        investigationId: 'demo-investigation-api-latency',
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
