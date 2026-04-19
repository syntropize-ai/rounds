import { ensureSafeUrl } from './url-validator.js';

/**
 * Shape required for a connectivity probe. Intentionally narrower than
 * `InstanceDatasource` so UI callers can test before a record is
 * persisted.
 */
export interface DatasourceProbe {
  type: string;
  url: string;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}

/** Test connectivity to a datasource by hitting its health / readiness endpoint. */
export async function testDatasourceConnection(
  ds: DatasourceProbe,
): Promise<{ ok: boolean; message: string }> {
  try {
    // SSRF protection: validate the base URL before making any request
    await ensureSafeUrl(ds.url);

    const headers: Record<string, string> = {};
    if (ds.apiKey) {
      headers['Authorization'] = `Bearer ${ds.apiKey}`;
    } else if (ds.username && ds.password) {
      headers['Authorization'] = `Basic ${Buffer.from(`${ds.username}:${ds.password}`).toString('base64')}`;
    }

    let testUrl: string;
    switch (ds.type) {
      case 'prometheus':
      case 'victoria-metrics':
        testUrl = `${ds.url.replace(/\/$/, '')}/api/v1/status/buildinfo`;
        break;
      case 'loki':
        testUrl = `${ds.url.replace(/\/$/, '')}/ready`;
        break;
      case 'elasticsearch':
        testUrl = `${ds.url.replace(/\/$/, '')}/_cluster/health`;
        break;
      case 'tempo':
        testUrl = `${ds.url.replace(/\/$/, '')}/ready`;
        break;
      case 'jaeger':
        testUrl = `${ds.url.replace(/\/$/, '')}/api/services`;
        break;
      default:
        testUrl = ds.url.replace(/\/$/, '');
    }

    const res = await fetch(testUrl, { headers, signal: AbortSignal.timeout(5_000) });
    if (res.ok)
      return { ok: true, message: 'Connected successfully' };
    return { ok: false, message: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' };
  }
}
