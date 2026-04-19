/**
 * LDAP configuration loader.
 *
 * Enabled when `OPENOBS_AUTH_LDAP_ENABLED=true` AND `config/ldap.toml` exists.
 * Any other combination is a silent skip — LDAP is optional.
 *
 * TOML schema matches docs/auth-perm-design/02-authentication.md §ldap-provider.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createLogger } from '@agentic-obs/common/logging';
// `@iarna/toml` is now a regular dependency (T9 / Wave 6 cutover). Prior to the
// cutover we dynamic-imported it so operators without LDAP didn't need the
// module; now that the dep is pinned we can static-import safely.
import toml from '@iarna/toml';

const log = createLogger('ldap-config');

export interface LdapAttributeMapping {
  username: string;
  email: string;
  name: string;
  memberOf: string;
}

export interface LdapGroupMapping {
  groupDn: string;
  orgId: string;
  orgRole: 'Admin' | 'Editor' | 'Viewer' | 'None';
  grafanaAdmin?: boolean;
}

export interface LdapServerConfig {
  host: string;
  port: number;
  useSsl: boolean;
  startTls: boolean;
  bindDn: string;
  bindPassword: string;
  searchBaseDns: string[];
  searchFilter: string;
  attributes: LdapAttributeMapping;
  groupMappings: LdapGroupMapping[];
}

export interface LdapConfig {
  servers: LdapServerConfig[];
}

const DEFAULT_CONFIG_PATH = 'config/ldap.toml';

export function ldapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['OPENOBS_AUTH_LDAP_ENABLED'] === 'true';
}

export function ldapConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['OPENOBS_LDAP_CONFIG_PATH'] || DEFAULT_CONFIG_PATH;
}

function toCamel<T extends object>(obj: unknown): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj as T;
  if (Array.isArray(obj)) return obj.map((v) => toCamel(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const camel = k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[camel] = toCamel(v);
  }
  return out as T;
}

/**
 * Load config from `path`. Returns null when:
 *   - the file doesn't exist
 *   - `@iarna/toml` can't be imported (not installed)
 *   - parsing fails
 * Never throws.
 */
export async function loadLdapConfig(
  path = DEFAULT_CONFIG_PATH,
): Promise<LdapConfig | null> {
  if (!existsSync(path)) {
    log.debug({ path }, 'ldap config not found; ldap disabled');
    return null;
  }
  const parser = toml as unknown as { parse: (s: string) => unknown };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = toCamel<Record<string, unknown>>(parser.parse(raw));
    const servers = parsed['servers'] as LdapServerConfig[] | undefined;
    if (!servers || servers.length === 0) return null;
    // Normalize defaults.
    const normalized = servers.map((s) => ({
      host: s.host,
      port: s.port ?? (s.useSsl ? 636 : 389),
      useSsl: !!s.useSsl,
      startTls: !!s.startTls,
      bindDn: s.bindDn,
      bindPassword: s.bindPassword,
      searchBaseDns: s.searchBaseDns ?? [],
      searchFilter: s.searchFilter ?? '(cn=%s)',
      attributes: {
        username: s.attributes?.username ?? 'cn',
        email: s.attributes?.email ?? 'mail',
        name: s.attributes?.name ?? 'displayName',
        memberOf: s.attributes?.memberOf ?? 'memberOf',
      },
      groupMappings: s.groupMappings ?? [],
    }));
    return { servers: normalized };
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'ldap config parse failed',
    );
    return null;
  }
}
