import type { DbClient } from '../db/client.js';
import type {
  IInvestigationRepository,
  IIncidentRepository,
  IFeedRepository,
  ICaseRepository,
  IApprovalRepository,
  IShareRepository,
} from './interfaces.js';

import { InMemoryInvestigationRepository } from './memory/investigation.js';
import { InMemoryIncidentRepository } from './memory/incident.js';
import { InMemoryFeedRepository } from './memory/feed.js';
import { InMemoryCaseRepository } from './memory/case.js';
import { InMemoryApprovalRepository } from './memory/approval.js';
import { InMemoryShareRepository } from './memory/share.js';

import { PostgresInvestigationRepository } from './postgres/investigation.js';
import { PostgresIncidentRepository } from './postgres/incident.js';
import { PostgresFeedRepository } from './postgres/feed.js';
import { PostgresCaseRepository } from './postgres/case.js';
import { PostgresApprovalRepository } from './postgres/approval.js';
import { PostgresShareRepository } from './postgres/share.js';

export interface Repositories {
  investigations: IInvestigationRepository;
  incidents: IIncidentRepository;
  feed: IFeedRepository;
  cases: ICaseRepository;
  approvals: IApprovalRepository;
  shares: IShareRepository;
}

export function createInMemoryRepositories(): Repositories {
  return {
    investigations: new InMemoryInvestigationRepository(),
    incidents: new InMemoryIncidentRepository(),
    feed: new InMemoryFeedRepository(),
    cases: new InMemoryCaseRepository(),
    approvals: new InMemoryApprovalRepository(),
    shares: new InMemoryShareRepository(),
  };
}

export function createPostgresRepositories(db: DbClient): Repositories {
  return {
    investigations: new PostgresInvestigationRepository(db),
    incidents: new PostgresIncidentRepository(db),
    feed: new PostgresFeedRepository(db),
    cases: new PostgresCaseRepository(db),
    approvals: new PostgresApprovalRepository(db),
    shares: new PostgresShareRepository(db),
  };
}

export type RepositoryBackend = 'memory' | 'postgres';

export function createRepositories(
  backend: RepositoryBackend,
  db?: DbClient,
): Repositories {
  if (backend === 'postgres') {
    if (!db) throw new Error('DbClient is required for postgres backend');
    return createPostgresRepositories(db);
  }
  return createInMemoryRepositories();
}
