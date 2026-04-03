// API Gateway process entry point - calls startServer()
import { createLogger } from '@agentic-obs/common';
import { startServer } from './server.js';

const log = createLogger('main');

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'unhandled rejection');
  // Don't exit — just log for observability
});

const port = parseInt(process.env['PORT'] ?? '3000', 10);
startServer(port);
