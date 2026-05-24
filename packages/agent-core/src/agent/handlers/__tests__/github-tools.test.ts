import { describe, it, expect, vi } from 'vitest';
import { AdapterRegistry } from '../../../adapters/index.js';
import {
  handleGithubListRepos,
  handleGithubListPrs,
  handleGithubGetPr,
  handleGithubGetDiff,
} from '../github-tools.js';
import type { ActionContext } from '../_context.js';
import type { GithubToolRunner } from '../../agent-types.js';

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    gateway: {} as ActionContext['gateway'],
    model: 'test',
    store: {} as ActionContext['store'],
    investigationReportStore: {} as ActionContext['investigationReportStore'],
    alertRuleStore: {} as ActionContext['alertRuleStore'],
    adapters: new AdapterRegistry(),
    sendEvent: vi.fn(),
    sessionId: 'session-1',
    identity: { userId: 'u1', orgId: 'org_a', orgRole: 'Admin', isServerAdmin: false, authenticatedBy: 'session' },
    accessControl: {
      evaluate: async () => true,
      filterByPermission: async (_id, rows) => rows,
    },
    actionExecutor: {} as ActionContext['actionExecutor'],
    emitAgentEvent: vi.fn(),
    makeAgentEvent: ((type: string) => ({ type, agentType: 'orchestrator', timestamp: '' })) as ActionContext['makeAgentEvent'],
    pushConversationAction: vi.fn(),
    setNavigateTo: vi.fn(),
    recordCreatedResource: vi.fn(),
    investigationSections: new Map(),
    investigationProvenance: new Map(),
    activeInvestigationId: null,
    activeDashboardId: null,
    freshlyCreatedDashboards: new Set(),
    dashboardBuildEvidence: {
      webSearchCount: 0,
      metricDiscoveryCount: 0,
      validatedQueries: new Set(),
    },
    ...overrides,
  } as ActionContext;
}

function mkRunner(): GithubToolRunner {
  return {
    listRepos: vi.fn(async () => ({ observation: 'repos-ok', data: [] })),
    listPrs: vi.fn(async () => ({ observation: 'prs-ok', data: [] })),
    getPr: vi.fn(async () => ({ observation: 'pr-ok', data: {} })),
    getDiff: vi.fn(async () => ({ observation: 'diff-text' })),
  };
}

describe('github-tools handlers', () => {
  it('handleGithubListRepos returns "not configured" when no runner is wired', async () => {
    const ctx = makeCtx();
    const out = await handleGithubListRepos(ctx, {});
    expect(out).toContain('GitHub connector is not configured');
  });

  it('handleGithubListRepos forwards connectorId + identity to the runner', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({ githubToolRunner: runner });
    const out = await handleGithubListRepos(ctx, { connectorId: 'gh-a' });
    expect(out).toBe('repos-ok');
    expect(runner.listRepos).toHaveBeenCalledWith({
      connectorId: 'gh-a',
      identity: ctx.identity,
    });
  });

  it('handleGithubListPrs validates owner/repo and passes args through', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({ githubToolRunner: runner });

    const missing = await handleGithubListPrs(ctx, { repo: 'web' });
    expect(missing).toContain('requires owner and repo');

    const ok = await handleGithubListPrs(ctx, {
      owner: 'acme',
      repo: 'web',
      state: 'closed',
      limit: 5,
    });
    expect(ok).toBe('prs-ok');
    expect(runner.listPrs).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'web',
      state: 'closed',
      limit: 5,
      identity: ctx.identity,
    });
  });

  it('handleGithubGetPr requires a numeric number', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({ githubToolRunner: runner });
    const bad = await handleGithubGetPr(ctx, { owner: 'acme', repo: 'web' });
    expect(bad).toContain('requires owner, repo, and number');
    expect(runner.getPr).not.toHaveBeenCalled();
  });

  it('handleGithubGetDiff returns the runner observation as-is (no truncation in the handler)', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({ githubToolRunner: runner });
    const out = await handleGithubGetDiff(ctx, { owner: 'acme', repo: 'web', number: 7 });
    expect(out).toBe('diff-text');
    expect(runner.getDiff).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'web',
      number: 7,
      identity: ctx.identity,
    });
  });
});
