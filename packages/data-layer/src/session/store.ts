import { randomUUID } from 'node:crypto';
import type { Session, SessionMessage } from './types.js';

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(userId: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
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

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  update(id: string, updates: Partial<Session>): Session {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error(`Session not found: ${id}`);
    const updated: Session = {
      ...existing,
      ...updates,
      id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  listByUser(userId: string): Session[] {
    return Array.from(this.sessions.values()).filter((s) => s.userId === userId);
  }

  addMessage(sessionId: string, message: SessionMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const updated: Session = {
      ...session,
      context: {
        ...session.context,
        messages: [...session.context.messages, message],
      },
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
  }

  linkInvestigation(sessionId: string, investigationId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.investigationIds.includes(investigationId)) return;
    const updated: Session = {
      ...session,
      investigationIds: [...session.investigationIds, investigationId],
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, updated);
  }
}
