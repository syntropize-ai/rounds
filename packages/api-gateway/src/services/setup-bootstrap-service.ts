import type {
  IOrgRepository,
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { AuditAction } from '@agentic-obs/common';
import { hashPassword, passwordMinLength } from '../auth/local-provider.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { SessionService } from '../auth/session-service.js';
import type { SetupConfigService } from './setup-config-service.js';

export interface SetupBootstrapServiceDeps {
  setupConfig: SetupConfigService;
  users: IUserRepository;
  orgs: IOrgRepository;
  orgUsers: IOrgUserRepository;
  sessions: SessionService;
  audit: AuditWriter;
  defaultOrgId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BootstrapAdminInput {
  email?: string;
  name?: string;
  login?: string;
  password?: string;
  userAgent?: string;
  ip?: string;
}

export interface BootstrapAdminResult {
  userId: string;
  orgId: string;
  sessionToken: string;
}

export class SetupBootstrapServiceError extends Error {
  constructor(
    public readonly kind: 'validation' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'SetupBootstrapServiceError';
  }
}

function assertValidEmail(email: string): void {
  const atIdx = email.indexOf('@');
  if (atIdx < 1 || atIdx === email.length - 1 || !email.slice(atIdx + 1).includes('.')) {
    throw new SetupBootstrapServiceError('validation', 'valid email required');
  }
}

export class SetupBootstrapService {
  constructor(private readonly deps: SetupBootstrapServiceDeps) {}

  async createFirstAdmin(input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
    if (await this.deps.setupConfig.isBootstrapped()) {
      throw new SetupBootstrapServiceError('conflict', 'admin already exists');
    }

    const email = typeof input.email === 'string' ? input.email.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const login =
      typeof input.login === 'string' && input.login.trim() !== ''
        ? input.login.trim()
        : email.split('@')[0] ?? '';
    const password = typeof input.password === 'string' ? input.password : '';

    assertValidEmail(email);
    if (!name) throw new SetupBootstrapServiceError('validation', 'name required');
    if (!login) throw new SetupBootstrapServiceError('validation', 'login required');

    const minLen = passwordMinLength(this.deps.env ?? process.env);
    if (password.length < minLen) {
      throw new SetupBootstrapServiceError(
        'validation',
        `password must be at least ${minLen} characters`,
      );
    }

    const orgId = this.deps.defaultOrgId ?? 'org_main';
    const existingOrg = await this.deps.orgs.findById(orgId);
    if (!existingOrg) {
      await this.deps.orgs.create({ id: orgId, name: 'Main Org' });
    }

    const hashed = await hashPassword(password);
    const user = await this.deps.users.create({
      email,
      name,
      login,
      password: hashed,
      orgId,
      isAdmin: true,
      emailVerified: true,
    });
    await this.deps.orgUsers.create({ orgId, userId: user.id, role: 'Admin' });

    // Close the bootstrap gate before issuing the session. If any later step
    // fails, reruns should observe that an admin already exists.
    await this.deps.setupConfig.markBootstrapped();

    const session = await this.deps.sessions.create(
      user.id,
      input.userAgent ?? '',
      input.ip ?? '',
    );
    void this.deps.audit.log({
      action: AuditAction.UserCreated,
      actorType: 'system',
      actorId: 'setup-wizard',
      targetType: 'user',
      targetId: user.id,
      outcome: 'success',
      metadata: { bootstrap: true, orgId },
    });

    return { userId: user.id, orgId, sessionToken: session.token };
  }
}
