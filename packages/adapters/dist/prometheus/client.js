// Prometheus HTTP API client (real + mock)
// — Real HTTP client —
export class PrometheusHttpClient {
    baseUrl;
    headers;
    timeoutMs;

    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.timeoutMs = config.timeoutMs ?? 30_000;
        this.headers = { 'Content-Type': 'application/json', ...(config.headers ?? {}) };
        
        if (config.auth) {
            const token = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
            this.headers['Authorization'] = `Basic ${token}`;
        }
    }

    async instantQuery(promql, time) {
        const params = new URLSearchParams({ query: promql });
        if (time) {
            params.set('time', String(time.getTime() / 1000));
        }
        const res = await this.fetch(`/api/v1/query?${params}`);
        return res;
    }

    async rangeQuery(promql, start, end, step) {
        const params = new URLSearchParams({
            query: promql,
            start: String(start.getTime() / 1000),
            end: String(end.getTime() / 1000),
            step,
        });
        const res = await this.fetch(`/api/v1/query_range?${params}`);
        return res;
    }

    async health() {
        try {
            const res = await fetch(`${this.baseUrl}/-/healthy`, {
                headers: this.headers,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            return res.ok;
        } catch (error) {
            return false;
        }
    }

    async fetch(path) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            headers: this.headers,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
            throw new Error(`Prometheus HTTP error ${res.status}: ${await res.text()}`);
        }
        return res.json();
    }
}

export class MockPrometheusClient {
    series = [];
    healthy = true;

    setSeries(series) {
        this.series = series;
    }

    setHealthy(healthy) {
        this.healthy = healthy;
    }

    async health() {
        return this.healthy;
    }

    async instantQuery(promql, time) {
        const ts = time ? time.getTime() / 1000 : Date.now() / 1000;
        return {
            status: 'success',
            data: {
                resultType: 'vector',
                result: this.series.map((s) => ({
                    metric: s.metric,
                    value: s.value ?? [ts, '0'],
                })),
            },
        };
    }

    async rangeQuery(promql, start, end, step) {
        return {
            status: 'success',
            data: {
                resultType: 'matrix',
                result: this.series.map((s) => ({
                    metric: s.metric,
                    values: s.values ?? this.generateSyntheticValues(start, end, step),
                })),
            },
        };
    }

    generateSyntheticValues(start, end, step) {
        const stepSeconds = parseStep(step);
        const points = [];
        let t = Math.floor(start.getTime() / 1000);
        const endTs = Math.floor(end.getTime() / 1000);
        while (t <= endTs) {
            // Synthetic sine wave + small noise for realistic-looking data
            const value = (Math.sin(t / 60) * 0.1 + 0.5).toFixed(4);
            points.push([t, value]);
            t += stepSeconds;
        }
        return points;
    }
}

function parseStep(step) {
    const match = step.match(/^(\d+)([smhd]?)$/);
    if (!match) return 60;
    const n = parseInt(match[1] ?? '60', 10);
    switch (match[2]) {
        case 'h': return n * 3600;
        case 'm': return n * 60;
        case 'd': return n * 86400;
        default: return n;
    }
}