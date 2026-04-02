import type { Investigation } from '@agentic-obs/common';
import type { DbClient } from '../../db/client.js';
import type { IInvestigationRepository, InvestigationFindAllOptions } from '../interfaces.js';
export declare class PostgresInvestigationRepository implements IInvestigationRepository {
  private readonly db;
  constructor(db: DbClient);
  findById(id: string): Promise<Investigation | undefined>;
  findAll(opts?: InvestigationFindAllOptions): Promise<Investigation[]>;
  create(data: Omit<Investigation, 'id' | 'createdAt'> & {
    id?: string;
  }): Promise<Investigation>;
  update(id: string, patch: Partial<Omit<Investigation, 'id'>>): Promise<Investigation | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  findBySession(sessionId: string): Promise<Investigation[]>;
  findByUser(userId: string, tenantId?: string): Promise<Investigation[]>;
  archive(id: string): Promise<Investigation | undefined>;
  restore(id: string): Promise<Investigation | undefined>;
  findArchived(tenantId?: string): Promise<Investigation[]>;
}
//# sourceMappingURL=investigation.d.ts.map
