import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultOpsSecretRefResolver, redactRef, UnsupportedSecretRefError } from './ops-secret-ref-resolver.js';

const resolver = new DefaultOpsSecretRefResolver();
const touchedEnv: string[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of touchedEnv.splice(0)) delete process.env[key];
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DefaultOpsSecretRefResolver', () => {
  it('resolves env:// refs', async () => {
    touchedEnv.push('OPENOBS_TEST_KUBECONFIG');
    process.env['OPENOBS_TEST_KUBECONFIG'] = 'apiVersion: v1\nkind: Config\n';

    await expect(resolver.resolve('env://OPENOBS_TEST_KUBECONFIG')).resolves.toContain('kind: Config');
  });

  it('resolves file:// refs with absolute paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openobs-secret-ref-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'kubeconfig.yaml');
    await writeFile(path, 'apiVersion: v1\nkind: Config\n', 'utf8');

    await expect(resolver.resolve(`file://${path}`)).resolves.toContain('apiVersion');
  });

  it('rejects unsupported providers explicitly', async () => {
    await expect(resolver.resolve('aws-sm://k8s/prod')).rejects.toBeInstanceOf(UnsupportedSecretRefError);
  });

  it('redacts non-env refs in messages', () => {
    expect(redactRef('env://OPENOBS_TEST_KUBECONFIG')).toBe('env://OPENOBS_TEST_KUBECONFIG');
    expect(redactRef('file:///secret/kubeconfig')).toBe('file://***');
    expect(redactRef('vault://k8s/prod')).toBe('vault://***');
  });

  it('resolves vault:// refs using VAULT_ADDR and VAULT_TOKEN', async () => {
    touchedEnv.push('VAULT_ADDR', 'VAULT_TOKEN');
    process.env['VAULT_ADDR'] = 'https://vault.example.com';
    process.env['VAULT_TOKEN'] = 'token';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { data: { kubeconfig: 'apiVersion: v1\nkind: Config\n' } } }),
    } as Response);

    await expect(resolver.resolve('vault://secret/data/k8s/prod#kubeconfig')).resolves.toContain('kind: Config');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://vault.example.com/v1/secret/data/k8s/prod',
      { headers: { 'X-Vault-Token': 'token' } },
    );
  });
});
