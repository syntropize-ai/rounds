// — Level normalisation ———————————————————————————————————————————————————————
function normaliseLevel(raw) {
    switch (raw?.toLowerCase()) {
        case 'trace': return 'trace';
        case 'debug': return 'debug';
        case 'info':
        case 'information': return 'info';
        case 'warn':
        case 'warning': return 'warn';
        case 'error': return 'error';
        case 'fatal':
        case 'critical': return 'fatal';
        default: return 'unknown';
    }
}

// — Input sanitisation helpers ————————————————————————————————————————————————
const KNOWN_LOG_LEVELS = new Set([
    'trace', 'debug', 'info', 'information',
    'warn', 'warning', 'error', 'fatal', 'critical',
]);

/** Return true only for well-known log-level strings (whitelist). */
function isKnownLogLevel(value) {
    return KNOWN_LOG_LEVELS.has(value.toLowerCase());
}

/**
 * Escape double-quote characters inside a Loki label value.
 * Prevents injection through label matchers like `service="..."`.
 */
function escapeLabelValue(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escape all RE2/PCRE metacharacters in a user-supplied pattern so that it
 * is treated as a literal substring search rather than an arbitrary regex.
 * Also escapes "`" because the result is embedded inside a Loki `|~ "..."` filter.
 *
 * Characters escaped: . * + ? ^ $ { } [ ] | ( ) \ "
 */
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\"/]/g, '\\$&');
}

// — Loki HTTP client ——————————————————————————————————————————————————————————
export class LokiHttpClient {
    baseUrl;
    timeoutMs;
    headers;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.timeoutMs = config.timeoutMs ?? 30_000;
        this.headers = {
            'Content-Type': 'application/json',
            ...(config.headers ?? {}),
        };
        if (config.auth) {
            const encoded = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
            this.headers['Authorization'] = `Basic ${encoded}`;
        }
    }

    async queryLogs(params) {
        const selector = this.buildSelector(params);
        const url = new URL(`${this.baseUrl}/loki/api/v1/query_range`);
        url.searchParams.set('query', selector);
        url.searchParams.set('start', String(params.start.getTime() * 1_000_000)); // ns
        url.searchParams.set('end', String(params.end.getTime() * 1_000_000));
        url.searchParams.set('limit', String(params.limit ?? 1000));
        url.searchParams.set('direction', 'forward');
        const res = await fetch(url.toString(), {
            headers: this.headers,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
            throw new Error(`Loki HTTP ${res.status}: ${res.statusText}`);
        }
        const body = await res.json();
        if (body.status === 'error') {
            throw new Error(`Loki query error: ${body.error}`);
        }
        return this.parseStreams(body, params.entity);
    }

    async health() {
        try {
            const res = await fetch(`${this.baseUrl}/ready`, {
                signal: AbortSignal.timeout(5_000),
            });
            return res.ok;
        }
        catch {
            return false;
        }
    }

    buildSelector(params) {
        const labels = [`service="${escapeLabelValue(params.entity)}"`];
        const filters = params.filters ?? {};
        if (filters['namespace']) {
            labels.push(`namespace="${escapeLabelValue(String(filters['namespace']))}"`);
        }
        if (filters['pod']) {
            labels.push(`pod="${escapeLabelValue(String(filters['pod']))}"`);
        }
        let selector = `{${labels.join(',')}}`;
        // Log-level filter - whitelist only known levels to prevent injection
        if (filters['level']) {
            const raw = Array.isArray(filters['level']) ? filters['level'] : [filters['level']];
            const safe = raw.filter(isKnownLogLevel);
            if (safe.length > 0) {
                selector += ` |~ "(?i)(${safe.join('|')})"`; 
            }
        }
        // Free-text pattern filter - escape regex metacharacters to prevent injection
        if (filters['pattern']) {
            selector += ` |~ "${escapeRegex(String(filters['pattern']))}"`;
        }
        return selector;
    }

    parseStreams(body, entity) {
        const lines = [];
        for (const stream of body.data.result) {
            const labels = stream.stream;
            for (const [tsNs, raw] of stream.values) {
                const tsMs = Number(tsNs) / 1_000_000;
                lines.push({
                    timestamp: new Date(tsMs).toISOString(),
                    level: normaliseLevel(labels['level'] ?? labels['severity']),
                    message: raw,
                    service: labels['service'] ?? entity,
                    labels,
                    traceId: labels['traceID'] ?? labels['trace_id'] ?? undefined,
                    spanId: labels['spanID'] ?? labels['span_id'] ?? undefined,
                });
            }
        }
        return lines.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
}

export class MockLogClient {
    lines;
    shouldFail;
    failMessage;
    constructor(options = {}) {
        this.lines = options.lines ?? [];
        this.shouldFail = options.shouldFail ?? false;
        this.failMessage = options.failMessage ?? 'Mock log client error';
    }
    async queryLogs(params) {
        if (this.shouldFail)
            throw new Error(this.failMessage);
        return this.lines.filter((l) => {
            const ts = new Date(l.timestamp).getTime();
            return ts >= params.start.getTime() && ts <= params.end.getTime();
        });
    }
    async health() {
        return !this.shouldFail;
    }
    /** Replace the lines returned by future queries (useful in tests). */
    setLines(lines) {
        this.lines = lines;
    }
    setFailing(fail) {
        this.shouldFail = fail;
    }
}
//# sourceMappingURL=client.js.map