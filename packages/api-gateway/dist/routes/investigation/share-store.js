import { randomUUID } from 'node:crypto';
import { markDirty } from '../../persistence.js';

export class ShareStore {
  shares = new Map();

  create(params) {
    const token = randomUUID();
    const now = new Date();
    const link = {
      token,
      investigationId: params.investigationId,
      createdBy: params.createdBy,
      permission: params.permission ?? 'view_only',
      createdAt: now.toISOString(),
      expiresAt: params.expiresInMs
        ? new Date(Date.now() + params.expiresInMs).toISOString()
        : null,
    };
    this.shares.set(token, link);
    markDirty();
    return link;
  }

  findByToken(token) {
    const link = this.shares.get(token);
    if (!link) {
      return undefined;
    }
    // Check expiration
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      this.shares.delete(token);
      return undefined;
    }
    return link;
  }

  findByInvestigation(investigationId) {
    const now = Date.now();
    return [...this.shares.values()].filter((s) => s.investigationId === investigationId &&
      (!s.expiresAt || new Date(s.expiresAt).getTime() > now));
  }

  revoke(token) {
    const result = this.shares.delete(token);
    if (result) {
      markDirty();
    }
    return result;
  }

  get size() {
    return this.shares.size;
  }

  clear() {
    this.shares.clear();
  }

  toJSON() {
    return [...this.shares.values()];
  }

  loadJSON(data) {
    if (!Array.isArray(data)) {
      return;
    }
    for (const s of data) {
      if (s.token) {
        this.shares.set(s.token, s);
      }
    }
  }
}

export const defaultShareStore = new ShareStore();
//# sourceMappingURL=share-store.js.map
