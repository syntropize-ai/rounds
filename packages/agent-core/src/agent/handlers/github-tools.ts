/**
 * GitHub VCS read tools. Each handler is a thin shim that:
 *   1. Validates required args.
 *   2. Delegates to `ctx.githubToolRunner` (concrete impl lives in
 *      api-gateway/services/github-tool-runner.ts).
 *   3. Wraps the call in `withToolEventBoundary` so the chat panel renders
 *      a tool_call / tool_result pair like every other agent tool.
 *
 * The runner returns a polite observation string for every failure (auth,
 * 404, policy block, rate limit) — handlers never throw across this
 * boundary. That keeps the model in control of how it explains the result.
 */

import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

function formatResult(result: { observation: string }): string {
  return result.observation;
}

export async function handleGithubListRepos(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
  return withToolEventBoundary(
    ctx.sendEvent,
    'github_list_repos',
    { connectorId: connectorId || undefined },
    connectorId ? `Listing GitHub repos via ${connectorId}` : 'Listing GitHub repos',
    async () => {
      if (!ctx.githubToolRunner) {
        return 'GitHub connector is not configured. Connect one via Settings → Connectors → GitHub.';
      }
      const result = await ctx.githubToolRunner.listRepos({
        ...(connectorId ? { connectorId } : {}),
        identity: ctx.identity,
      });
      return formatResult(result);
    },
  );
}

export async function handleGithubListPrs(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
  const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
  const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
  const state =
    args.state === 'open' || args.state === 'closed' || args.state === 'all'
      ? args.state
      : 'open';
  const limit = typeof args.limit === 'number' ? args.limit : undefined;

  return withToolEventBoundary(
    ctx.sendEvent,
    'github_list_prs',
    { connectorId: connectorId || undefined, owner, repo, state, limit },
    `Listing PRs on ${owner}/${repo}`,
    async () => {
      if (!ctx.githubToolRunner) {
        return 'GitHub connector is not configured. Connect one via Settings → Connectors → GitHub.';
      }
      if (!owner || !repo) {
        return 'github_list_prs requires owner and repo.';
      }
      const result = await ctx.githubToolRunner.listPrs({
        ...(connectorId ? { connectorId } : {}),
        owner,
        repo,
        state,
        ...(limit !== undefined ? { limit } : {}),
        identity: ctx.identity,
      });
      return formatResult(result);
    },
  );
}

export async function handleGithubGetPr(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
  const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
  const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
  const number = typeof args.number === 'number' ? args.number : Number(args.number);

  return withToolEventBoundary(
    ctx.sendEvent,
    'github_get_pr',
    { connectorId: connectorId || undefined, owner, repo, number },
    `Reading PR ${owner}/${repo}#${number}`,
    async () => {
      if (!ctx.githubToolRunner) {
        return 'GitHub connector is not configured. Connect one via Settings → Connectors → GitHub.';
      }
      if (!owner || !repo || !Number.isFinite(number)) {
        return 'github_get_pr requires owner, repo, and number.';
      }
      const result = await ctx.githubToolRunner.getPr({
        ...(connectorId ? { connectorId } : {}),
        owner,
        repo,
        number,
        identity: ctx.identity,
      });
      return formatResult(result);
    },
  );
}

export async function handleGithubGetDiff(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
  const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
  const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
  const number = typeof args.number === 'number' ? args.number : Number(args.number);

  return withToolEventBoundary(
    ctx.sendEvent,
    'github_get_diff',
    { connectorId: connectorId || undefined, owner, repo, number },
    `Reading diff of ${owner}/${repo}#${number}`,
    async () => {
      if (!ctx.githubToolRunner) {
        return 'GitHub connector is not configured. Connect one via Settings → Connectors → GitHub.';
      }
      if (!owner || !repo || !Number.isFinite(number)) {
        return 'github_get_diff requires owner, repo, and number.';
      }
      const result = await ctx.githubToolRunner.getDiff({
        ...(connectorId ? { connectorId } : {}),
        owner,
        repo,
        number,
        identity: ctx.identity,
      });
      return formatResult(result);
    },
  );
}
