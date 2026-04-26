// API Gateway process entry point.
//
// The import ORDER here is load-bearing: `bootstrap-secrets` hydrates
// JWT_SECRET / SECRET_KEY BEFORE any module that validates or consumes them
// runs. Server / websocket-gateway / secret-box imports happen inside
// startServer, so the env is ready by the time they resolve.

import { createLogger } from '@agentic-obs/common/logging';
import { bootstrapSecretsIfNeeded } from './auth/bootstrap-secrets.js';
import { dataDir } from './paths.js';

const log = createLogger('main');

// Every path in the gateway resolves through ./paths.ts — historically
// this block resolved DATA_DIR independently and five different modules
// each picked a different default directory name (.uname-data vs
// .agentic-obs vs ~/.agentic-obs), so the SQLite DB, secrets, and
// config.json landed in three separate places.
const bootstrap = bootstrapSecretsIfNeeded(dataDir());
if (bootstrap.injected.length > 0) {
  log.info(
    { injected: bootstrap.injected, generated: bootstrap.generated, path: bootstrap.path },
    bootstrap.generated
      ? 'generated and persisted local crypto secrets (dev / first-run bootstrap)'
      : 'loaded local crypto secrets from disk',
  );
}

// Import startServer AFTER the bootstrap so modules that read env at import
// time (or call `process.env['JWT_SECRET']` in their top-level init) see the
// hydrated values.
const { startServer } = await import('./server.js');

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'unhandled rejection');
  // Don't exit — just log for observability
});

const port = parseInt(process.env['PORT'] ?? '3000', 10);
startServer(port).catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : err }, 'startServer failed');
  process.exit(1);
});
