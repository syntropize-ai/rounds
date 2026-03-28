import type { LogLine, LogCluster } from './types.js';

/**
 * Extract a stable template from a log message by replacing variable parts
 * with the placeholder `<*>`. Consecutive placeholders are merged.
 */
export declare function extractTemplate(message: string): string;

/**
 * Group log lines into clusters by their extracted template.
 * Lines with identical templates are in the same cluster.
 *
 * @param lines      - Input log lines (any order).
 * @param maxSamples - Max sample lines stored per cluster (default: 3).
 */
export declare function clusterLogs(lines: LogLine[], maxSamples?: number): LogCluster[];
//# sourceMappingURL=clusterer.d.ts.map