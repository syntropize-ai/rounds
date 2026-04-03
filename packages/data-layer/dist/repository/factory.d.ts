import type { DbClient } from '../db/client.js';
import type { IInvestigationRepository, IIncidentRepository, IFeedRepository, ICaseRepository, IApprovalRepository, IShareRepository } from './interfaces.js';
export interface Repositories {
    investigations: IInvestigationRepository;
    incidents: IIncidentRepository;
    feed: IFeedRepository;
    cases: ICaseRepository;
    approvals: IApprovalRepository;
    shares: IShareRepository;
}
export declare function createInMemoryRepositories(): Repositories;
export declare function createPostgresRepositories(db: DbClient): Repositories;
export type RepositoryBackend = 'memory' | 'postgres';
export declare function createRepositories(backend: RepositoryBackend, db?: DbClient): Repositories;
//# sourceMappingURL=factory.d.ts.map