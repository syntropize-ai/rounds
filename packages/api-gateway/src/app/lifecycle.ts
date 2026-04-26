/**
 * Shutdown-hook helpers extracted from `server.ts::startServer()`.
 *
 * `createShutdownHooks(httpServer, gateway)` builds a GracefulShutdown
 * with the http-server + websocket-gateway hooks registered at
 * STOP_HTTP_SERVER priority. The caller decides when to attach OS signal
 * handlers (`gs.listen()`) so test harnesses that drive shutdown
 * directly can keep their own signal wiring.
 */

import type { Server as HttpServer } from 'node:http';
import {
  GracefulShutdown,
  ShutdownPriority,
} from '@agentic-obs/common/lifecycle';

interface WebSocketGatewayLike {
  close(): Promise<void> | void;
}

export function createShutdownHooks(
  httpServer: HttpServer,
  gateway: WebSocketGatewayLike,
): GracefulShutdown {
  const shutdown = new GracefulShutdown();

  shutdown.register({
    name: 'http-server',
    priority: ShutdownPriority.STOP_HTTP_SERVER,
    timeoutMs: 5_000,
    handler: () =>
      new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve(undefined)));
      }),
  });

  shutdown.register({
    name: 'websocket-gateway',
    priority: ShutdownPriority.STOP_HTTP_SERVER,
    timeoutMs: 5_000,
    handler: () => Promise.resolve(gateway.close()),
  });

  return shutdown;
}
