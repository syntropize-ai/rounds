import { describe, it, expect, vi } from 'vitest';
import type { IConnectorRepository } from '@agentic-obs/data-layer';
import { backfillKubernetesPolicyDefaults } from './connectors-backfill.js';

/**
 * Phase A (ops-trust-model v4): the per-capability per-team policy
 * matrix has been retired. `backfillKubernetesPolicyDefaults` is now a
 * no-op kept for boot-wiring compatibility. These tests pin that
 * behavior: no repo writes, no exceptions, no boot block — even when
 * the repo is broken.
 */

function makeRepo(): {
  repo: IConnectorRepository;
  list: ReturnType<typeof vi.fn>;
  listPolicies: ReturnType<typeof vi.fn>;
  upsertPolicy: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn();
  const listPolicies = vi.fn();
  const upsertPolicy = vi.fn();
  const repo = {
    list,
    listPolicies,
    upsertPolicy,
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    findByCapability: vi.fn(),
    getSecret: vi.fn(),
    upsertSecret: vi.fn(),
    deleteSecret: vi.fn(),
    getPolicy: vi.fn(),
    deletePolicy: vi.fn(),
  } as unknown as IConnectorRepository;
  return { repo, list, listPolicies, upsertPolicy };
}

describe('backfillKubernetesPolicyDefaults (Phase A no-op)', () => {
  it('does not query the repo for connectors', async () => {
    const { repo, list } = makeRepo();
    await backfillKubernetesPolicyDefaults(repo, 'org_main');
    expect(list).not.toHaveBeenCalled();
  });

  it('does not list policies', async () => {
    const { repo, listPolicies } = makeRepo();
    await backfillKubernetesPolicyDefaults(repo, 'org_main');
    expect(listPolicies).not.toHaveBeenCalled();
  });

  it('does not upsert any policy rows', async () => {
    const { repo, upsertPolicy } = makeRepo();
    await backfillKubernetesPolicyDefaults(repo, 'org_main');
    expect(upsertPolicy).not.toHaveBeenCalled();
  });

  it('returns void without throwing even if the repo would have failed', async () => {
    const repo = {
      list: vi.fn(async () => {
        throw new Error('db down');
      }),
      listPolicies: vi.fn(async () => {
        throw new Error('db down');
      }),
      upsertPolicy: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as IConnectorRepository;
    await expect(
      backfillKubernetesPolicyDefaults(repo, 'org_main'),
    ).resolves.toBeUndefined();
  });

  it('is safe to call repeatedly (idempotent no-op)', async () => {
    const { repo, list, upsertPolicy } = makeRepo();
    await backfillKubernetesPolicyDefaults(repo, 'org_a');
    await backfillKubernetesPolicyDefaults(repo, 'org_b');
    await backfillKubernetesPolicyDefaults(repo, 'org_a');
    expect(list).not.toHaveBeenCalled();
    expect(upsertPolicy).not.toHaveBeenCalled();
  });
});
