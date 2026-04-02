import type { IShareRepository, FindAllOptions } from '../interfaces.js';
import type { ShareLink } from '../types.js';
export declare class InMemoryShareRepository implements IShareRepository {
  private readonly items;
  findById(id: string): Promise<ShareLink | undefined>;
  findByToken(token: string): Promise<ShareLink | undefined>;
  findAll(opts?: FindAllOptions<ShareLink>): Promise<ShareLink[]>;
  create(data: Omit<ShareLink, 'id' | 'createdAt'> & {
    id?: string;
  }): Promise<ShareLink>;
  update(id: string, patch: Partial<Omit<ShareLink, 'id'>>): Promise<ShareLink | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  findByInvestigation(investigationId: string): Promise<ShareLink[]>;
  revoke(token: string): Promise<boolean>;
  private checkExpiry;
  clear(): void;
}
//# sourceMappingURL=share.d.ts.map
