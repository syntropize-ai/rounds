import type { DbClient } from '../../db/client.js';
import type { IApprovalRepository, FindAllOptions } from '../interfaces.js';
import type { ApprovalRecord } from '../types.js';
export declare class PostgresApprovalRepository implements IApprovalRepository {
  private readonly db;
  constructor(db: DbClient);
  findById(id: string): Promise<ApprovalRecord | undefined>;
  findAll(opts?: FindAllOptions<ApprovalRecord>): Promise<ApprovalRecord[]>;
  create(data: Omit<ApprovalRecord, 'id' | 'createdAt'> & {
    id?: string;
  }): Promise<ApprovalRecord>;
  submit(data: Omit<ApprovalRecord, 'id' | 'createdAt'>): Promise<ApprovalRecord>;
  update(id: string, patch: Partial<Omit<ApprovalRecord, 'id'>>): Promise<ApprovalRecord | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  listPending(tenantId?: string): Promise<ApprovalRecord[]>;
  approve(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined>;
  reject(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined>;
  override(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined>;
}
//# sourceMappingURL=approval.d.ts.map
