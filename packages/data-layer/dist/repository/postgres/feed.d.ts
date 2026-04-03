import type { DbClient } from '../../db/client.js';
import type { IFeedRepository, FeedFindAllOptions } from '../interfaces.js';
import type { FeedEvent } from '../types.js';
export declare class PostgresFeedRepository implements IFeedRepository {
    private readonly db;
    constructor(db: DbClient);
    findById(id: string): Promise<FeedEvent | undefined>;
    findAll(opts?: FeedFindAllOptions): Promise<FeedEvent[]>;
    create(data: Omit<FeedEvent, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<FeedEvent>;
    add(data: Omit<FeedEvent, 'id' | 'createdAt'>): Promise<FeedEvent>;
    update(id: string, patch: Partial<Omit<FeedEvent, 'id'>>): Promise<FeedEvent | undefined>;
    delete(id: string): Promise<boolean>;
    count(): Promise<number>;
    findByType(type: string, tenantId?: string): Promise<FeedEvent[]>;
    findBySeverity(severity: string, tenantId?: string): Promise<FeedEvent[]>;
}
//# sourceMappingURL=feed.d.ts.map