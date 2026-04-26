import { readFile } from 'node:fs/promises';

export interface OpsSecretRefResolver {
  resolve(ref: string): Promise<string>;
}

export class UnsupportedSecretRefError extends Error {
  constructor(ref: string) {
    super(`Unsupported Ops secretRef "${redactRef(ref)}". Supported schemes: env://VAR_NAME, file://ABSOLUTE_PATH, vault://path#field.`);
    this.name = 'UnsupportedSecretRefError';
  }
}

export class DefaultOpsSecretRefResolver implements OpsSecretRefResolver {
  async resolve(ref: string): Promise<string> {
    const trimmed = ref.trim();
    if (!trimmed) throw new UnsupportedSecretRefError(ref);

    if (trimmed.startsWith('env://')) {
      const key = trimmed.slice('env://'.length);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid env secretRef "${redactRef(ref)}".`);
      }
      const value = process.env[key];
      if (!value) {
        throw new Error(`Environment secretRef "${redactRef(ref)}" is not set.`);
      }
      return value;
    }

    if (trimmed.startsWith('file://')) {
      const path = trimmed.slice('file://'.length);
      if (!path || !isAbsolutePath(path)) {
        throw new Error(`File secretRef "${redactRef(ref)}" must be an absolute path.`);
      }
      return readFile(path, 'utf8');
    }

    if (trimmed.startsWith('vault://')) {
      return this.resolveVault(trimmed);
    }

    throw new UnsupportedSecretRefError(ref);
  }

  private async resolveVault(ref: string): Promise<string> {
    const addr = process.env['VAULT_ADDR'];
    const token = process.env['VAULT_TOKEN'];
    if (!addr || !token) {
      throw new Error('Vault secretRef requires VAULT_ADDR and VAULT_TOKEN.');
    }

    const parsed = new URL(ref);
    const field = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : 'kubeconfig';
    const vaultPath = `${parsed.hostname}${parsed.pathname}`;
    if (!vaultPath || vaultPath === '/') {
      throw new Error(`Vault secretRef "${redactRef(ref)}" must include a secret path.`);
    }

    const endpoint = `${addr.replace(/\/+$/, '')}/v1/${vaultPath.replace(/^\/+/, '')}`;
    const response = await fetch(endpoint, {
      headers: { 'X-Vault-Token': token },
    });
    if (!response.ok) {
      throw new Error(`Vault secretRef "${redactRef(ref)}" returned HTTP ${response.status}.`);
    }
    const body = await response.json() as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    const nested = typeof data['data'] === 'object' && data['data'] !== null
      ? data['data'] as Record<string, unknown>
      : data;
    const value = nested[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Vault secretRef "${redactRef(ref)}" did not contain string field "${field}".`);
    }
    return value;
  }
}

export function redactRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('env://')) return trimmed;
  if (trimmed.startsWith('file://')) return 'file://***';
  if (trimmed.startsWith('vault://')) return 'vault://***';
  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//)?.[1];
  return scheme ? `${scheme}://***` : '***';
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}
