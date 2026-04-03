// Prometheus query proxy - lets frontend panels fetch live data
// Resolves datasource from setup config, proxies PromQL to Prometheus
import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { PrometheusHttpClient } from '@agentic-obs/adapters';
import { getSetupConfig } from '../setup.js';
// -- Helpers
function resolvePrometheusDatasource(datasourceId, environment, cluster) {
    const config = getSetupConfig();
    const isPrometheus = (d) => d.type === 'prometheus' || d.type === 'victoria-metrics';
    if (datasourceId) {
        return config.datasources.find((d) => d.id === datasourceId && isPrometheus(d)) ?? null;
    }
    const candidates = config.datasources.filter(isPrometheus);
    if (environment || cluster) {
        const match = candidates.find((d) => {
            if (environment && d.environment !== environment)
                return false;
            if (cluster && d.cluster !== cluster)
                return false;
            return true;
        });
        return match ?? null;
    }
    return candidates[0] ?? null;
}
function buildClientConfig(ds) {
    const cfg = { baseUrl: ds.url };
    if (ds.username && ds.password) {
        cfg.auth = { username: ds.username, password: ds.password };
    }
    else if (ds.apiKey) {
        cfg.headers = { Authorization: `Bearer ${ds.apiKey}` };
    }
    return cfg;
}
function buildFetchHeaders(ds) {
    if (ds.username && ds.password) {
        const token = Buffer.from(`${ds.username}:${ds.password}`).toString('base64');
        return { Authorization: `Basic ${token}` };
    }
    if (ds.apiKey) {
        return { Authorization: `Bearer ${ds.apiKey}` };
    }
    return {};
}
// -- Router
export function createQueryRouter() {
    const router = Router();
    // POST /api/query/range
    router.post('/range', authMiddleware, async (req, res) => {
        const { query, start, end, step = '30s', datasourceId, environment, cluster } = req.body;
        if (!query) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'query is required' } });
            return;
        }
        const ds = resolvePrometheusDatasource(datasourceId, environment, cluster);
        if (!ds) {
            res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } });
            return;
        }
        const endDate = end ? new Date(end) : new Date();
        const startDate = start ? new Date(start) : new Date(endDate.getTime() - 30 * 60 * 1000);
        try {
            const client = new PrometheusHttpClient(buildClientConfig(ds));
            const result = await client.rangeQuery(query, startDate, endDate, step);
            res.json(result);
        }
        catch (err) {
            res.status(502).json({
                error: { code: 'PROMETHEUS_ERROR', message: err instanceof Error ? err.message : String(err) },
            });
        }
    });
    // POST /api/query/instant
    router.post('/instant', authMiddleware, async (req, res) => {
        const { query, time, datasourceId, environment, cluster } = req.body;
        if (!query) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'query is required' } });
            return;
        }
        const ds = resolvePrometheusDatasource(datasourceId, environment, cluster);
        if (!ds) {
            res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } });
            return;
        }
        try {
            const client = new PrometheusHttpClient(buildClientConfig(ds));
            const result = await client.instantQuery(query, time ? new Date(time) : undefined);
            res.json(result);
        }
        catch (err) {
            res.status(502).json({
                error: { code: 'PROMETHEUS_ERROR', message: err instanceof Error ? err.message : String(err) },
            });
        }
    });
    // GET /api/query/metadata?match={pattern}&datasourceId=xxx&environment=prod&cluster=my-cluster-a
    // Returns metric names matching the pattern - used by LLM generator to reduce noise
    router.get('/metadata', authMiddleware, async (req, res) => {
        const { match, datasourceId, environment, cluster } = req.query;
        const ds = resolvePrometheusDatasource(datasourceId, environment, cluster);
        if (!ds) {
            res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } });
            return;
        }
        try {
            const baseUrl = ds.url.replace(/\/$/, '');
            const headers = buildFetchHeaders(ds);
            let url;
            if (match) {
                const params = new URLSearchParams();
                params.set('match[]', match);
                url = `${baseUrl}/api/v1/series?${params}`;
            }
            else {
                url = `${baseUrl}/api/v1/label/__name__/values`;
            }
            const fetchRes = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(10_000),
            });
            if (!fetchRes.ok) {
                res.status(502).json({
                    error: { code: 'PROMETHEUS_ERROR', message: `Prometheus HTTP ${fetchRes.status}` },
                });
                return;
            }
            const body = await fetchRes.json();
            if (match) {
                // For series endpoint, extract unique metric names from the __name__ label
                const series = body.data;
                const names = [...new Set(series.map((s) => s['__name__']).filter(Boolean))].sort();
                res.json({ status: 'success', data: names });
            }
            else {
                res.json(body);
            }
        }
        catch (err) {
            res.status(502).json({
                error: { code: 'PROMETHEUS_ERROR', message: err instanceof Error ? err.message : String(err) },
            });
        }
    });
    // GET /api/query/labels?metric={name}&datasourceId=xxx&environment=prod&cluster=my-cluster-a
    // Returns available label names for a metric
    router.get('/labels', authMiddleware, async (req, res) => {
        const { metric, datasourceId, environment, cluster } = req.query;
        const ds = resolvePrometheusDatasource(datasourceId, environment, cluster);
        if (!ds) {
            res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } });
            return;
        }
        try {
            const baseUrl = ds.url.replace(/\/$/, '');
            const headers = buildFetchHeaders(ds);
            const params = new URLSearchParams();
            if (metric)
                params.set('match[]', metric);
            const url = `${baseUrl}/api/v1/labels?${params}`;
            const fetchRes = await fetch(url, {
                headers,
                signal: AbortSignal.timeout(10_000),
            });
            if (!fetchRes.ok) {
                res.status(502).json({
                    error: { code: 'PROMETHEUS_ERROR', message: `Prometheus HTTP ${fetchRes.status}` },
                });
                return;
            }
            const body = await fetchRes.json();
            res.json(body);
        }
        catch (err) {
            res.status(502).json({
                error: { code: 'PROMETHEUS_ERROR', message: err instanceof Error ? err.message : String(err) },
            });
        }
    });
    // POST /api/query/batch
    // Executes multiple PromQL queries in parallel and returns per-refId results
    router.post('/batch', authMiddleware, async (req, res) => {
        const { queries, start, end, step = '30s', datasourceId, environment, cluster } = req.body;
        if (!queries || queries.length === 0) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'queries array is required and must not be empty' } });
            return;
        }
        if (queries.length > 20) {
            res.status(400).json({ error: { code: 'VALIDATION', message: 'queries array must not exceed 20 items' } });
            return;
        }
        for (const q of queries) {
            if (!q.refId || !q.expr) {
                res.status(400).json({ error: { code: 'VALIDATION', message: 'each query must have refId and expr' } });
                return;
            }
        }
        const ds = resolvePrometheusDatasource(datasourceId, environment, cluster);
        if (!ds) {
            res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } });
            return;
        }
        const client = new PrometheusHttpClient(buildClientConfig(ds));
        const endDate = end ? new Date(end) : new Date();
        const startDate = start ? new Date(start) : new Date(endDate.getTime() - 30 * 60 * 1000);
        const settled = await Promise.allSettled(queries.map((q) => q.instant
            ? client.instantQuery(q.expr)
            : client.rangeQuery(q.expr, startDate, endDate, step)));
        const results = {};
        queries.forEach((q, i) => {
            const outcome = settled[i];
            if (outcome.status === 'fulfilled') {
                results[q.refId] = { status: 'success', data: outcome.value };
            }
            else {
                const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                results[q.refId] = { status: 'error', data: { resultType: 'matrix', result: [] }, error: msg };
            }
        });
        res.json({ results });
    });
    return router;
}
//# sourceMappingURL=query.js.map