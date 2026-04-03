import type { User, Team, AuditLogEntry } from './types.js';
export declare class UserStore {
    private users;
    private emailIndex;
    private externalIndex;
    private teams;
    private auditLog;
    create(data: Omit<User, 'id' | 'createdAt' | 'lastLoginAt'>): User;
    findById(id: string): User | undefined;
    findByEmail(email: string): User | undefined;
    findByExternalId(provider: string, externalId: string): User | undefined;
    update(id: string, data: Partial<User>): User | undefined;
    updateLastLogin(id: string): void;
    delete(id: string): boolean;
    list(): User[];
    count(): number;
    createTeam(data: Omit<Team, 'id' | 'createdAt'>): Team;
    findTeamById(id: string): Team | undefined;
    updateTeam(id: string, data: Partial<Team>): Team | undefined;
    deleteTeam(id: string): boolean;
    listTeams(): Team[];
    addAuditEntry(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): void;
    getAuditLog(limit?: number, offset?: number): {
        entries: AuditLogEntry[];
        total: number;
    };
}
export declare const userStore: UserStore;
//# sourceMappingURL=user-store.d.ts.map