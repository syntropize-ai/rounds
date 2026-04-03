import type { Persistable } from '../../persistence.js';
export type SharePermission = 'view_only' | 'can_comment';
export interface ShareLink {
    token: string;
    investigationId: string;
    createdBy: string;
    permission: SharePermission;
    createdAt: string;
    expiresAt: string | null;
}
export declare class ShareStore implements Persistable {
    private readonly shares;
    create(params: {
        investigationId: string;
        createdBy: string;
        permission?: SharePermission;
        expiresInMs?: number;
    }): ShareLink;
    findByToken(token: string): ShareLink | undefined;
    findByInvestigation(investigationId: string): ShareLink[];
    revoke(token: string): boolean;
    get size(): number;
    clear(): void;
    toJSON(): unknown;
    loadJSON(data: unknown): void;
}
export declare const defaultShareStore: ShareStore;
//# sourceMappingURL=share-store.d.ts.map