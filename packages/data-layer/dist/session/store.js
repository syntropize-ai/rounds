import { randomUUID } from 'node:crypto';
export class SessionStore {
  sessions = new Map();
  create(userId) {
    const now = new Date().toISOString();
    const session = {
      id: randomUUID(),
      userId,
      status: 'active',
      context: { messages: [], metadata: {} },
      investigationIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id) {
    return this.sessions.get(id);
  }
  update(id, updates) {
    const existing = this.sessions.get(id);
    if (!existing) {
      throw new Error(`Session not found: ${id}`);
    }
    const updated = {
      ...existing,
      ...updates,
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, updated);
    return updated;
  }
  delete(id) {
    return this.sessions.delete(id);
  }
  listByUser(userId) {
    return Array.from(this.sessions.values()).filter((s) => s.userId === userId);
  }
  addMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const updated = {
      ...session,
      context: {
        ...session.context,
        messages: [...session.context.messages, message],
      },
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
  }
  linkInvestigation(sessionId, investigationId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.investigationIds.includes(investigationId)) {
      return;
    }
    const updated = {
      ...session,
      investigationIds: [...session.investigationIds, investigationId],
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
  }
}
//# sourceMappingURL=store.js.map
