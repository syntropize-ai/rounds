import { randomUUID } from 'node:crypto';
import { normalizeWebhook, type GitHubDeploymentPayload } from '@agentic-obs/adapters';
import type { ChangeRecord, IChangesAdapter } from '@agentic-obs/adapters';
import type { Change } from '@agentic-obs/common';
import type {
  ChangeEvent,
  ChangeSource,
  IChangeSourceRepository,
  NewChangeSource,
  PublicChangeSource,
} from '@agentic-obs/data-layer';

export type GitHubChangeSource = ChangeSource;

export interface NewGitHubChangeSource {
  orgId: string;
  name: string;
  owner?: string;
  repo?: string;
  events?: string[];
  secret?: string;
  active?: boolean;
}

export type PublicGitHubChangeSource = PublicChangeSource & {
  webhookPath: string;
};

export type CreatedGitHubChangeSource = PublicGitHubChangeSource & {
  secret: string;
};

const DEFAULT_GITHUB_EVENTS = ['deployment', 'deployment_status'];

export class GitHubChangeSourceRegistry {
  constructor(private readonly repo: IChangeSourceRepository) {}

  async list(orgId: string): Promise<PublicGitHubChangeSource[]> {
    const sources = await this.repo.listSources(orgId, { masked: true });
    return sources.map(toPublicSource);
  }

  async get(orgId: string, id: string): Promise<PublicGitHubChangeSource | null> {
    const source = await this.repo.findSourceByIdInOrg(orgId, id, { masked: true });
    return source ? toPublicSource(source) : null;
  }

  async getSecret(id: string): Promise<string | null> {
    return (await this.repo.findSourceById(id))?.secret ?? null;
  }

  async create(input: NewGitHubChangeSource): Promise<CreatedGitHubChangeSource> {
    const secret = input.secret?.trim() || randomUUID();
    const source = await this.repo.createSource(toRepoInput(input, secret));
    return { ...toPublicSource({ ...source, secret: maskSecret(secret) }), secret };
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    return this.repo.deleteSource(orgId, id);
  }

  async ingestGitHubWebhook(
    sourceId: string,
    eventName: string,
    payload: unknown,
  ): Promise<{ ok: true; ignored: boolean; record?: ChangeRecord } | { ok: false; status: number; message: string }> {
    const source = await this.repo.findSourceById(sourceId);
    if (!source || !source.active) {
      return { ok: false, status: 404, message: `GitHub change source "${sourceId}" not found` };
    }
    if (!source.events.includes(eventName)) {
      return { ok: true, ignored: true };
    }
    const normalized = toGitHubDeploymentPayload(eventName, payload);
    if (!normalized) {
      return { ok: true, ignored: true };
    }
    const change = normalizeWebhook({ source: 'github', payload: normalized });
    if (!change) return { ok: true, ignored: true };
    const saved = await this.repo.addEvent({
      orgId: source.orgId,
      sourceId: source.id,
      serviceId: change.serviceId,
      type: change.type,
      timestamp: change.timestamp,
      author: change.author,
      description: change.description,
      diff: change.diff,
      version: change.version,
      payload: payload as Record<string, unknown>,
    });
    return { ok: true, ignored: false, record: eventToChangeRecord(saved) };
  }

  async listAdapters(orgId: string): Promise<Array<{ id: string; name: string; adapter: IChangesAdapter }>> {
    const sources = await this.repo.listSources(orgId, { masked: true });
    return sources
      .filter((source) => source.active)
      .map((source) => ({
        id: source.id,
        name: source.name,
        adapter: new RepositoryChangesAdapter(this.repo, orgId, source.id),
      }));
  }
}

class RepositoryChangesAdapter implements IChangesAdapter {
  constructor(
    private readonly repo: IChangeSourceRepository,
    private readonly orgId: string,
    private readonly sourceId: string,
  ) {}

  async listRecent(input: { service?: string; windowMinutes: number }): Promise<ChangeRecord[]> {
    const end = new Date();
    const start = new Date(end.getTime() - input.windowMinutes * 60_000);
    const events = await this.repo.listEvents({
      orgId: this.orgId,
      sourceId: this.sourceId,
      serviceId: input.service,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      limit: 100,
    });
    return events.map(eventToChangeRecord);
  }
}

function toRepoInput(input: NewGitHubChangeSource, secret: string): NewChangeSource {
  return {
    orgId: input.orgId,
    type: 'github',
    name: input.name,
    owner: input.owner ?? null,
    repo: input.repo ?? null,
    events: input.events?.length ? input.events : DEFAULT_GITHUB_EVENTS,
    secret,
    active: input.active ?? true,
  };
}

function toGitHubDeploymentPayload(eventName: string, payload: unknown): GitHubDeploymentPayload | null {
  const body = payload as Partial<GitHubDeploymentPayload> | undefined;
  if (!body || typeof body !== 'object') return null;
  if (eventName === 'deployment') {
    return {
      ...body,
      action: 'created',
    } as GitHubDeploymentPayload;
  }
  if (eventName === 'deployment_status') {
    const state = (body as { deployment_status?: { state?: string } }).deployment_status?.state;
    const action = state === 'success' ? 'success'
      : state === 'failure' || state === 'error' ? 'failure'
        : 'pending';
    return {
      ...body,
      action,
    } as GitHubDeploymentPayload;
  }
  return null;
}

const CHANGE_KIND: Record<Change['type'], ChangeRecord['kind']> = {
  deploy: 'deploy',
  config: 'config',
  scale: 'config',
  feature_flag: 'feature-flag',
};

function eventToChangeRecord(change: ChangeEvent): ChangeRecord {
  return {
    id: change.id,
    service: change.serviceId,
    kind: CHANGE_KIND[change.type] ?? 'other',
    summary: change.description,
    at: change.timestamp,
    metadata: {
      author: change.author,
      ...(change.version ? { version: change.version } : {}),
      ...(change.diff ? { diff: change.diff } : {}),
    },
  };
}

function toPublicSource(source: ChangeSource): PublicGitHubChangeSource {
  const { secret: _secret, ...rest } = source;
  return {
    ...rest,
    webhookPath: `/api/change-sources/github/${source.id}/webhook`,
    secretMasked: source.secret,
  };
}

function maskSecret(secret: string): string {
  return secret.length <= 4 ? '••••••' : `••••••${secret.slice(-4)}`;
}
