import type { DbClient } from '../../db/client.js';
import type { ICaseRepository, CaseFindAllOptions } from '../interfaces.js';
import type { Case } from '../types.js';
export declare class PostgresCaseRepository implements ICaseRepository {
  private readonly db;
  constructor(db: DbClient);
  findById(id: string): Promise<Case | undefined>;
  findAll(opts?: CaseFindAllOptions): Promise<Case[]>;
  create(data: Omit<Case, 'id' | 'createdAt'> & {
    id?: string;
  }): Promise<Case>;
  update(id: string, patch: Partial<Omit<Case, 'id'>>): Promise<Case | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  search(query: string, limit?: number, tenantId?: string): Promise<Case[]>;
  findByService(serviceId: string, tenantId?: string): Promise<Case[]>;
}
//# sourceMappingURL=case.d.ts.map
