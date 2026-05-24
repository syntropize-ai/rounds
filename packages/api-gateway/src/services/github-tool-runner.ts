/**
 * GithubToolRunner — concrete implementation of `GithubToolRunner` from
 * agent-core, used by the four `github_*` chat tools (list_repos, list_prs,
 * get_pr, get_diff).
 *
 * Architecture:
 *   - One instance per chat turn (constructed in chat-service.ts, mirrors
 *     the pattern for KubectlOpsCommandRunner).
 *   - Auth: an installation token minted by GithubAppTokenService, cached
 *     in-memory across calls so the JWT-sign + token-mint round-trip
 *     happens at most once per hour per (orgId, installationId).
 *   - Policy: each method calls `resolveConnectorPolicy` from ops-policy
 *     with the matching `vcs.*` capability and short-circuits on `block`.
 *     `ask` and `allow` both pass through — these are read tools, so the
 *     confirmation card flow used by ops_run_command would only add noise.
 *   - Errors: every GitHub HTTP failure is converted to a polite
 *     observation string. The handler does not need to know about HTTP
 *     status codes.
 */

import { createLogger } from '@agentic-obs/server-utils/logging';
import type {
  GithubToolRunner as IGithubToolRunner,
  GithubToolResult,
} from '@agentic-obs/agent-core';
import type { Identity } from '@agentic-obs/common';
import type { IConnectorRepository } from '@agentic-obs/data-layer';
import {
  resolveConnectorPolicy,
  type PolicyDecision,
} from './ops-policy.js';
import type { GithubAppTokenService } from './github-app-token-service.js';

const log = createLogger('github-tool-runner');

const DIFF_MAX_BYTES = 256 * 1024;
const DEFAULT_PR_LIMIT = 20;
const MAX_PR_LIMIT = 100;

type Capability = 'vcs.repo.read' | 'vcs.pr.read' | 'vcs.diff.read';

export interface GithubToolRunnerDeps {
  tokens: GithubAppTokenService;
  connectors: IConnectorRepository;
  orgId: string;
  resolveUserTeams?: (identity: Identity) => Promise<readonly string[]>;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class GithubToolRunner implements IGithubToolRunner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: GithubToolRunnerDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async listRepos(args: { connectorId?: string; identity: Identity }): Promise<GithubToolResult> {
    const resolved = await this.resolveConnector(args.connectorId);
    if ('observation' in resolved) return resolved;
    const { connectorId } = resolved;

    const gate = await this.checkPolicy(connectorId, 'vcs.repo.read', args.identity);
    if (gate) return gate;

    const token = await this.tryMintToken(connectorId);
    if ('observation' in token) return token;

    return this.requestJson(token.token, 'GET', 'https://api.github.com/installation/repositories?per_page=100', (body) => {
      const list = (body as { repositories?: unknown }).repositories;
      if (!Array.isArray(list)) {
        return { observation: 'GitHub returned no repositories array.' };
      }
      const repos = list.map((r) => {
        const row = r as Record<string, unknown>;
        const ownerRec = row.owner as Record<string, unknown> | undefined;
        return {
          owner: typeof ownerRec?.login === 'string' ? ownerRec.login : '',
          name: typeof row.name === 'string' ? row.name : '',
          fullName: typeof row.full_name === 'string' ? row.full_name : '',
          private: row.private === true,
          defaultBranch: typeof row.default_branch === 'string' ? row.default_branch : '',
          description: typeof row.description === 'string' ? row.description : null,
        };
      });
      return {
        observation: `Found ${repos.length} repos:\n${JSON.stringify(repos, null, 2)}`,
        data: repos,
      };
    });
  }

  async listPrs(args: {
    connectorId?: string;
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    limit?: number;
    identity: Identity;
  }): Promise<GithubToolResult> {
    const resolved = await this.resolveConnector(args.connectorId);
    if ('observation' in resolved) return resolved;
    const { connectorId } = resolved;

    const gate = await this.checkPolicy(connectorId, 'vcs.pr.read', args.identity);
    if (gate) return gate;

    const token = await this.tryMintToken(connectorId);
    if ('observation' in token) return token;

    const limit = clampLimit(args.limit);
    const state = args.state ?? 'open';
    const url = `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls?state=${state}&per_page=${limit}`;

    return this.requestJson(token.token, 'GET', url, (body) => {
      if (!Array.isArray(body)) {
        return { observation: 'GitHub returned no PR array.' };
      }
      const prs = body.map((r) => {
        const row = r as Record<string, unknown>;
        const user = row.user as Record<string, unknown> | undefined;
        const head = row.head as Record<string, unknown> | undefined;
        const base = row.base as Record<string, unknown> | undefined;
        return {
          number: typeof row.number === 'number' ? row.number : 0,
          title: typeof row.title === 'string' ? row.title : '',
          state: typeof row.state === 'string' ? row.state : '',
          author: typeof user?.login === 'string' ? user.login : '',
          createdAt: typeof row.created_at === 'string' ? row.created_at : '',
          updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
          headBranch: typeof head?.ref === 'string' ? head.ref : '',
          baseBranch: typeof base?.ref === 'string' ? base.ref : '',
          url: typeof row.html_url === 'string' ? row.html_url : '',
          draft: row.draft === true,
        };
      });
      return {
        observation: `Found ${prs.length} ${state} PRs on ${args.owner}/${args.repo}:\n${JSON.stringify(prs, null, 2)}`,
        data: prs,
      };
    });
  }

  async getPr(args: {
    connectorId?: string;
    owner: string;
    repo: string;
    number: number;
    identity: Identity;
  }): Promise<GithubToolResult> {
    const resolved = await this.resolveConnector(args.connectorId);
    if ('observation' in resolved) return resolved;
    const { connectorId } = resolved;

    const gate = await this.checkPolicy(connectorId, 'vcs.pr.read', args.identity);
    if (gate) return gate;

    const token = await this.tryMintToken(connectorId);
    if ('observation' in token) return token;

    const url = `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${args.number}`;

    return this.requestJson(token.token, 'GET', url, (body) => {
      const row = body as Record<string, unknown>;
      const user = row.user as Record<string, unknown> | undefined;
      const head = row.head as Record<string, unknown> | undefined;
      const base = row.base as Record<string, unknown> | undefined;
      const pr = {
        number: typeof row.number === 'number' ? row.number : 0,
        title: typeof row.title === 'string' ? row.title : '',
        state: typeof row.state === 'string' ? row.state : '',
        body: typeof row.body === 'string' ? row.body : '',
        author: typeof user?.login === 'string' ? user.login : '',
        createdAt: typeof row.created_at === 'string' ? row.created_at : '',
        mergedAt: typeof row.merged_at === 'string' ? row.merged_at : null,
        headBranch: typeof head?.ref === 'string' ? head.ref : '',
        baseBranch: typeof base?.ref === 'string' ? base.ref : '',
        headSha: typeof head?.sha === 'string' ? head.sha : '',
        mergedSha: typeof row.merge_commit_sha === 'string' ? row.merge_commit_sha : null,
        changedFiles: typeof row.changed_files === 'number' ? row.changed_files : 0,
        additions: typeof row.additions === 'number' ? row.additions : 0,
        deletions: typeof row.deletions === 'number' ? row.deletions : 0,
        url: typeof row.html_url === 'string' ? row.html_url : '',
      };
      return {
        observation: `PR ${args.owner}/${args.repo}#${args.number}:\n${JSON.stringify(pr, null, 2)}`,
        data: pr,
      };
    });
  }

  async getDiff(args: {
    connectorId?: string;
    owner: string;
    repo: string;
    number: number;
    identity: Identity;
  }): Promise<GithubToolResult> {
    const resolved = await this.resolveConnector(args.connectorId);
    if ('observation' in resolved) return resolved;
    const { connectorId } = resolved;

    const gate = await this.checkPolicy(connectorId, 'vcs.diff.read', args.identity);
    if (gate) return gate;

    const token = await this.tryMintToken(connectorId);
    if ('observation' in token) return token;

    const url = `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${args.number}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `token ${token.token}`,
          Accept: 'application/vnd.github.diff',
          'User-Agent': 'rounds-api-gateway',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'github diff fetch threw');
      return { observation: `GitHub request failed: ${msg}` };
    }

    if (!res.ok) {
      return mapHttpError(res);
    }

    const text = await res.text();
    if (text.length > DIFF_MAX_BYTES) {
      const truncated = text.slice(0, DIFF_MAX_BYTES);
      return {
        observation: `${truncated}\n\n[diff truncated at ${DIFF_MAX_BYTES} bytes — original was ${text.length} bytes]`,
        data: truncated,
        truncated: true,
      };
    }
    return { observation: text, data: text };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async resolveConnector(
    connectorId: string | undefined,
  ): Promise<{ connectorId: string } | GithubToolResult> {
    if (connectorId) {
      const c = await this.deps.connectors.get(connectorId, { orgId: this.deps.orgId });
      if (!c) {
        return { observation: `GitHub connector "${connectorId}" not found in org ${this.deps.orgId}.` };
      }
      if (c.type !== 'github') {
        return { observation: `Connector "${c.name}" is type "${c.type}", not "github".` };
      }
      return { connectorId: c.id };
    }

    const all = await this.deps.connectors.list({ orgId: this.deps.orgId });
    const githubs = all.filter((c) => c.type === 'github');
    if (githubs.length === 0) {
      return {
        observation:
          'No GitHub connector configured. Connect one via Settings → Connectors → GitHub.',
      };
    }
    if (githubs.length === 1) {
      return { connectorId: githubs[0]!.id };
    }
    const available = githubs.map((c) => `${c.id} (${c.name})`).join(', ');
    return {
      observation: `Multiple GitHub connectors; specify connectorId — available: ${available}.`,
    };
  }

  private async checkPolicy(
    connectorId: string,
    capability: Capability,
    identity: Identity,
  ): Promise<GithubToolResult | null> {
    const teamIds = this.deps.resolveUserTeams
      ? await this.deps.resolveUserTeams(identity)
      : [];
    const explicit: PolicyDecision = await resolveConnectorPolicy({
      connectorRepo: this.deps.connectors,
      connectorId,
      capability,
      orgId: this.deps.orgId,
      userTeamIds: teamIds,
    });
    if (explicit === 'block') {
      return {
        observation:
          `Blocked by connector policy: capability "${capability}" on "${connectorId}" is set to block. ` +
          `Adjust via Settings → Connectors → ${connectorId} → Permissions.`,
      };
    }
    return null;
  }

  private async tryMintToken(connectorId: string): Promise<{ token: string } | GithubToolResult> {
    try {
      const token = await this.deps.tokens.getInstallationToken(this.deps.orgId, connectorId);
      return { token };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ connectorId, err: msg }, 'github installation token mint failed');
      return {
        observation:
          'GitHub auth failed — the App installation may have been revoked. Reconnect via Settings → Connectors → GitHub.',
      };
    }
  }

  private async requestJson(
    token: string,
    method: 'GET',
    url: string,
    shape: (body: unknown) => GithubToolResult,
  ): Promise<GithubToolResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'rounds-api-gateway',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ url, err: msg }, 'github request threw');
      return { observation: `GitHub request failed: ${msg}` };
    }

    if (!res.ok) {
      return mapHttpError(res);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { observation: `GitHub returned non-JSON body: ${msg}` };
    }
    return shape(body);
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_PR_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_PR_LIMIT);
}

async function mapHttpError(res: Response): Promise<GithubToolResult> {
  const status = res.status;
  if (status === 401 || status === 403) {
    return {
      observation:
        'GitHub auth failed — the App installation may have been revoked. Reconnect via Settings → Connectors → GitHub.',
    };
  }
  if (status === 404) {
    return {
      observation: "Repo/PR not found, or the App installation doesn't have access to it.",
    };
  }
  if (status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const seconds = reset ? Math.max(0, Number(reset) - Math.floor(Date.now() / 1000)) : 0;
    const hint = seconds > 0 ? ` Try again in ${seconds} seconds.` : '';
    return { observation: `GitHub rate-limited the request —${hint}` };
  }
  let detail = '';
  try {
    const t = await res.text();
    detail = t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    /* ignore */
  }
  return { observation: `GitHub API error: ${status} ${detail}`.trim() };
}
