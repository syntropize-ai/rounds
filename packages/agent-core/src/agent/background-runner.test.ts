/**
 * Background runner — SA token resolution semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { runBackgroundAgent } from './background-runner.js';

describe('runBackgroundAgent', () => {
  it('throws when saToken is empty', async () => {
    const deps = {
      saTokens: { validateAndLookup: vi.fn().mockResolvedValue(null) },
      makeOrchestrator: vi.fn(),
    };
    await expect(
      runBackgroundAgent(deps as any, { saToken: '', message: 'hi' }),
    ).rejects.toThrow('saToken or identity is required');
    expect(deps.saTokens.validateAndLookup).not.toHaveBeenCalled();
  });

  it('throws when the token does not resolve', async () => {
    const deps = {
      saTokens: { validateAndLookup: vi.fn().mockResolvedValue(null) },
      makeOrchestrator: vi.fn(),
    };
    await expect(
      runBackgroundAgent(deps as any, { saToken: 'openobs_sa_bad', message: 'hi' }),
    ).rejects.toThrow('failed to resolve');
    expect(deps.makeOrchestrator).not.toHaveBeenCalled();
  });

  it('resolves SA token to identity and dispatches to the agent', async () => {
    const handleMessage = vi.fn().mockResolvedValue('ok');
    const deps = {
      saTokens: {
        validateAndLookup: vi.fn().mockResolvedValue({
          user: { id: 'sa-1', isAdmin: false },
          orgId: 'org_main',
          role: 'Viewer',
          serviceAccountId: 'sa-1',
          keyId: 'key-1',
          isServerAdmin: false,
        }),
      },
      makeOrchestrator: vi.fn().mockReturnValue({ handleMessage }),
    };
    const reply = await runBackgroundAgent(deps as any, {
      saToken: 'openobs_sa_abc',
      message: 'go',
    });
    expect(reply).toBe('ok');
    const identityArg = deps.makeOrchestrator.mock.calls[0]![0].identity;
    expect(identityArg.userId).toBe('sa-1');
    expect(identityArg.orgId).toBe('org_main');
    expect(identityArg.orgRole).toBe('Viewer');
    expect(identityArg.serviceAccountId).toBe('sa-1');
    expect(identityArg.authenticatedBy).toBe('api_key');
  });

  it('passes an explicit session id into the orchestrator factory', async () => {
    const handleMessage = vi.fn().mockResolvedValue('ok');
    const deps = {
      saTokens: { validateAndLookup: vi.fn() },
      makeOrchestrator: vi.fn().mockReturnValue({ handleMessage }),
    };
    await runBackgroundAgent(deps as any, {
      identity: {
        userId: 'sa-1',
        orgId: 'org_main',
        orgRole: 'Editor',
        isServerAdmin: false,
        authenticatedBy: 'api_key',
      },
      sessionId: 'auto-alert:rule-1:run-1',
      message: 'go',
    });

    expect(deps.makeOrchestrator).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'auto-alert:rule-1:run-1',
    }));
  });
});
