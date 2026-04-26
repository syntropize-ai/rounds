/**
 * LdapProvider — orchestrates admin-bind → user-search → re-bind → group
 * mapping → user upsert.
 *
 * Server configs iterated in order; first server that finds the user wins.
 * Failure to bind as the user = invalidCredentials (same 401 as local-auth).
 */

import {
  AuthError,
  type IOrgUserRepository,
  type IUserRepository,
  type OrgRole,
  type User,
} from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { LdapConfig } from './config.js';
import { authenticate, type LdapUserRecord } from './client.js';
import { mapGroupsToRoles } from './group-mapping.js';

const log = createLogger('ldap-provider');

/**
 * Distinguish "this looks like credentials are wrong / user not found" from
 * "the LDAP server is unreachable or misconfigured". The former should fall
 * through to the local provider; the latter should 503 with a clear admin
 * message.
 *
 * Credential-shaped failures we recognize:
 *   - InvalidCredentialsError (LDAP code 49) — bad password.
 *   - NoSuchObjectError       (LDAP code 32) — DN doesn't exist.
 *
 * NOT credential-shaped:
 *   - InsufficientAccessRightsError (LDAP code 50) — the *bind* DN we use
 *     to search lacks read permission on the directory subtree. This is a
 *     server/admin configuration problem, not "the user typed the wrong
 *     password", so it should surface as LDAP_UNREACHABLE (503), not 401.
 *   - ECONNREFUSED, ETIMEDOUT, etc. — infrastructure.
 */
function isCredentialError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number | string; lde_message?: string };
  // ldapjs error names
  if (
    e.name === 'InvalidCredentialsError' ||
    e.name === 'NoSuchObjectError'
  ) {
    return true;
  }
  // numeric LDAP result codes (49 = invalidCredentials, 32 = noSuchObject)
  if (e.code === 49 || e.code === 32 || e.code === '49' || e.code === '32') return true;
  return false;
}

export interface LdapLoginInput {
  user: string;
  password: string;
}

export interface LdapLoginResult {
  user: User;
  record: LdapUserRecord;
  orgRoles: Map<string, OrgRole>;
  isServerAdmin: boolean;
}

export interface LdapProviderDeps {
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  defaultOrgId: string;
}

export class LdapProvider {
  constructor(
    private readonly cfg: LdapConfig,
    private readonly deps: LdapProviderDeps,
  ) {}

  async login(input: LdapLoginInput): Promise<LdapLoginResult> {
    if (!input.user || !input.password) {
      throw AuthError.invalidCredentials();
    }
    let lastInfrastructureError: unknown;
    for (const server of this.cfg.servers) {
      let rec: LdapUserRecord | null;
      try {
        rec = await authenticate(server, {
          login: input.user,
          password: input.password,
        });
      } catch (err) {
        if (isCredentialError(err)) {
          // Credential-shaped failure → keep the original behavior (try next
          // server, then fall through to invalidCredentials at the end).
          log.debug(
            { server: server.host, err: err instanceof Error ? err.message : String(err) },
            'ldap auth failed with credential error',
          );
          continue;
        }
        // Infrastructure failure (connection refused, timeout, bad config…).
        // Remember it; if no server in the list works we surface it as
        // AuthError.internal so the route can map it to 503 instead of 401.
        log.warn(
          {
            server: server.host,
            errClass: err instanceof Error ? err.constructor.name : typeof err,
            err: err instanceof Error ? err.message : String(err),
          },
          'ldap auth failed with infrastructure error',
        );
        lastInfrastructureError = err;
        continue;
      }
      if (!rec) continue;
      const mapping = mapGroupsToRoles(rec.groupDns, server.groupMappings);
      const user = await this.upsertUser(rec, mapping.isServerAdmin);
      await this.syncOrgMemberships(user.id, mapping.orgRoles);
      return {
        user,
        record: rec,
        orgRoles: mapping.orgRoles,
        isServerAdmin: mapping.isServerAdmin,
      };
    }
    // No server returned a record. Differentiate "couldn't reach any server"
    // from "found you, password wrong" so the route can render the correct
    // status code.
    if (lastInfrastructureError) {
      throw AuthError.internal(
        `LDAP unreachable: ${lastInfrastructureError instanceof Error ? lastInfrastructureError.message : String(lastInfrastructureError)}`,
      );
    }
    throw AuthError.invalidCredentials();
  }

  private async upsertUser(
    rec: LdapUserRecord,
    isServerAdmin: boolean,
  ): Promise<User> {
    const existing =
      (await this.deps.users.findByLogin(rec.username)) ??
      (rec.email ? await this.deps.users.findByEmail(rec.email) : null);
    if (existing) {
      const updated = await this.deps.users.update(existing.id, {
        name: rec.name || existing.name,
        email: rec.email || existing.email,
        isAdmin: isServerAdmin || existing.isAdmin,
      });
      return updated ?? existing;
    }
    return this.deps.users.create({
      login: rec.username,
      name: rec.name,
      email: rec.email,
      orgId: this.deps.defaultOrgId,
      emailVerified: true,
      isAdmin: isServerAdmin,
    });
  }

  private async syncOrgMemberships(
    userId: string,
    roles: Map<string, OrgRole>,
  ): Promise<void> {
    for (const [orgId, role] of roles.entries()) {
      const membership = await this.deps.orgUsers.findMembership(orgId, userId);
      if (membership) {
        if (membership.role !== role) {
          await this.deps.orgUsers.updateRole(orgId, userId, role);
        }
      } else {
        await this.deps.orgUsers.create({ orgId, userId, role });
      }
    }
  }
}
