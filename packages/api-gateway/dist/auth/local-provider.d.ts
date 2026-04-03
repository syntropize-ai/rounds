import type { UserRole } from './types.js';
import type { User } from './types.js';
export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
export declare function localLogin(email: string, password: string): Promise<User | null>;
export declare function createLocalUser(email: string, password: string, name: string, role?: UserRole): Promise<User>;
//# sourceMappingURL=local-provider.d.ts.map