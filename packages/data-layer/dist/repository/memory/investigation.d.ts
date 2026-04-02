import type { Investigation } from '@agentic-obs/common';
import type { IInvestigationRepository, InvestigationFindAllOptions } from '../interfaces.js';
export declare class InMemoryInvestigationRepository implements IInvestigationRepository {
  private readonly active;
  private readonly archived;
  findById(id: string): Promise<Investigation | undefined>;
  findAll(opts?: InvestigationFindAllOptions): Promise<Investigation[]>;
  create(data: Omit<Investigation, 'id' | 'createdAt'> & {
    id?: string;
  }): Promise<Investigation>;
  update(id: string, patch: Partial<Omit<Investigation, 'id'>>): Promise<Investigation | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  findBySession(sessionId: string): Promise<Investigation[]>;
  findByUser(userId: string, _tenantId?: string): Promise<Investigation[]>;
  archive(id: string): Promise<Investigation | undefined>;
  restore(id: string): Promise<Investigation | undefined>;
  findArchived(_tenantId?: string): Promise<Investigation[]>;
  /** Test helper */
  clear(): void;
}
//# sourceMappingURL=investigation.d.ts.map
