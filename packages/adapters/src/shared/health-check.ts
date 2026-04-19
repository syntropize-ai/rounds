import { createLogger } from '@agentic-obs/common/logging';

const defaultLog = createLogger('health-check');

/**
 * Checks if a service endpoint is reachable and returns HTTP 2xx.
 */
export async function checkEndpointHealth(
  url: string,
  opts?: { logger?: ReturnType<typeof createLogger>; timeoutMs?: number },
): Promise<boolean> {
  const log = opts?.logger ?? defaultLog;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 5000),
    });
    return res.ok;
  } catch (err) {
    log.debug({ err, url }, 'health check failed');
    return false;
  }
}
