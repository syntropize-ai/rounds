import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';
export interface Role {
    name: string;
    /** Permissions in "resource:action" format; "*" is a wildcard for either part */
    permissions: string[];
}
export declare const BUILTIN_ROLES: Readonly<Record<string, Role>>;
export declare class RoleStore {
    private roles;
    constructor();
    getRole(name: string): Role | undefined;
    getAllRoles(): Role[];
    /** Create or replace a role */
    createRole(role: Role): void;
    /** Update an existing role (alias for createRole when name already exists) */
    updateRole(role: Role): boolean;
    deleteRole(name: string): boolean;
    /**
     * Resolve the merged permission set for a list of role names.
     * Permissions from all matching roles are combined and deduplicated.
     */
    resolvePermissions(roleNames: string[]): string[];
}
export declare const roleStore: RoleStore;
/**
 * Returns true if `required` is covered by at least one entry in `userPermissions`.
 *
 * Wildcard rules (both parts may independently be "*"):
 * - "*" matches everything
 * - "res:*" matches any action on resource "res"
 * - "*:act" matches action "act" on any resource
 * - "res:act" exact match only
 */
export declare function hasPermission(userPermissions: string[], required: string): boolean;
/** Returns true if ALL required permissions are covered by userPermissions */
export declare function hasAllPermissions(userPermissions: string[], required: string[]): boolean;
/** Express middleware - rejects the request with 403 if permission is missing */
export declare function requirePermission(permission: string): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
//# sourceMappingURL=rbac.d.ts.map
