import { createHash } from 'node:crypto';

// — Template extraction ———————————————————————————————————————————————————————
// Patterns that represent variable content in log messages
const VARIABLE_PATTERNS = [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUID
    /\b[0-9a-f]{16,64}\b/g, // hex strings (trace IDs, etc.)
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, // ISO timestamps
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:::\d+)?\b/g, // IP:port
    /\b\d+ms\b/g, // durations like 123ms
    /\b\d+(\.\d+)?(s|kb|mb|gb|bytes?)\b/gi, // sizes / durations
    /\b\d+\b/g, // bare numbers (last, most aggressive)
];

/**
 * Extract a stable template from a log message by replacing variable parts
 * with the placeholder `<*>`. Consecutive placeholders are merged.
 */
export function extractTemplate(message) {
    let template = message;
    for (const pattern of VARIABLE_PATTERNS) {
        template = template.replace(pattern, '<*>');
    }
    // Collapse consecutive <*> tokens
    return template.replace(/(<\*>\s*){2,}/g, '<*>').trim();
}

/**
 * Stable hash of a template string used as cluster ID.
 */
function templateId(template) {
    return createHash('sha256').update(template).digest('hex').slice(0, 16);
}

/**
 * Determine the dominant log level from a list of lines.
 */
function dominantLevel(lines) {
    const order = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'unknown'];
    for (const level of order) {
        if (lines.some((l) => l.level === level))
            return level;
    }
    return 'unknown';
}

/**
 * Group log lines into clusters by their extracted template.
 * Lines with identical templates are in the same cluster.
 *
 * @param lines      - Input log lines (any order).
 * @param maxSamples - Max sample lines stored per cluster (default: 3).
 */
export function clusterLogs(lines, maxSamples = 3) {
    const buckets = new Map();
    for (const line of lines) {
        const template = extractTemplate(line.message);
        const id = templateId(template);
        const bucket = buckets.get(id);
        if (bucket) {
            bucket.lines.push(line);
        }
        else {
            buckets.set(id, { template, lines: [line] });
        }
    }
    return Array.from(buckets.entries())
        .map(([id, { template, lines: clusterLines }]) => {
        const sorted = [...clusterLines].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        return {
            id,
            template,
            count: clusterLines.length,
            sampleLines: sorted.slice(0, maxSamples),
            level: dominantLevel(clusterLines),
            firstSeen: sorted[0].timestamp,
            lastSeen: sorted[sorted.length - 1].timestamp,
        };
    })
        .sort((a, b) => b.count - a.count); // most frequent first
}
//# sourceMappingURL=clusterer.js.map