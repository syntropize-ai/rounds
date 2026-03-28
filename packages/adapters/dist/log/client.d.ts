import type { LogLine, LogAdapterConfig } from './types.js';

export interface LogQueryParams {
    entity: string;
    start: Date;
    end: Date;
    filters?: Record<string, string | string[]>;
    limit?: number;
}

export interface ILogClient {
    queryLogs(params: LogQueryParams): Promise<LogLine[]>;
    health(): Promise<boolean>;
}

export declare class LokiHttpClient implements ILogClient {
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly headers;
    constructor(config: LogAdapterConfig);
    queryLogs(params: LogQueryParams): Promise<LogLine[]>;
    health(): Promise<boolean>;
    private buildSelector;
    private parseStreams;
}

export interface MockLogClientOptions {
    lines?: LogLine[];
    shouldFail?: boolean;
    failMessage?: string;
}

export declare class MockLogClient implements ILogClient {
    private lines;
    private shouldFail;
    private failMessage;
    constructor(options?: MockLogClientOptions);
    queryLogs(params: LogQueryParams): Promise<LogLine[]>;
    health(): Promise<boolean>;
    /** Replace the lines returned by future queries (useful in tests). */
    setLines(lines: LogLine[]): void;
    setFailing(fail: boolean): void;
}
//# sourceMappingURL=client.d.ts.map