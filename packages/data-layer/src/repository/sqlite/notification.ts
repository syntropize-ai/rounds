import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type {
  ContactPoint,
  ContactPointIntegration,
  NotificationPolicyNode,
  MuteTiming,
  TimeInterval,
} from '@agentic-obs/common';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { toJsonColumn } from '../json-column.js';
import {
  contactPoints,
  notificationPolicyTree,
  muteTimings,
} from '../../db/sqlite-schema.js';
import type { INotificationRepository } from '../interfaces.js';
import { isMutedByTimings, routeIntoTree } from '../notification-routing.js';

type ContactPointRow = typeof contactPoints.$inferSelect;
type MuteTimingRow = typeof muteTimings.$inferSelect;

function rowToContactPoint(row: ContactPointRow): ContactPoint {
  return {
    id: row.id,
    name: row.name,
    integrations: row.integrations as ContactPointIntegration[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToMuteTiming(row: MuteTimingRow): MuteTiming {
  return {
    id: row.id,
    name: row.name,
    timeIntervals: row.timeIntervals as TimeInterval[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaultPolicyTree(): NotificationPolicyNode {
  const now = new Date().toISOString();
  return {
    id: 'root',
    matchers: [],
    contactPointId: '',
    groupBy: ['alertname'],
    groupWaitSec: 30,
    groupIntervalSec: 300,
    repeatIntervalSec: 3600,
    continueMatching: false,
    muteTimingIds: [],
    children: [],
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  };
}

export class SqliteNotificationRepository implements INotificationRepository {
  constructor(private readonly db: SqliteClient) {}

  // — Contact Points

  async createContactPoint(data: { name: string; integrations: ContactPointIntegration[] }): Promise<ContactPoint> {
    const now = new Date().toISOString();
    const id = `cp_${randomUUID().slice(0, 12)}`;
    const [row] = await this.db
      .insert(contactPoints)
      .values({
        id,
        name: data.name,
        integrations: data.integrations as unknown[],
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToContactPoint(row!);
  }

  async findAllContactPoints(): Promise<ContactPoint[]> {
    const rows = await this.db.select().from(contactPoints);
    return rows.map(rowToContactPoint);
  }

  async findContactPointById(id: string): Promise<ContactPoint | undefined> {
    const [row] = await this.db.select().from(contactPoints).where(eq(contactPoints.id, id));
    return row ? rowToContactPoint(row) : undefined;
  }

  async updateContactPoint(
    id: string,
    patch: Partial<Omit<ContactPoint, 'id' | 'createdAt'>>,
  ): Promise<ContactPoint | undefined> {
    const sets: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) sets.name = patch.name;
    if (patch.integrations !== undefined) sets.integrations = patch.integrations;
    const [row] = await this.db
      .update(contactPoints)
      .set(sets)
      .where(eq(contactPoints.id, id))
      .returning();
    return row ? rowToContactPoint(row) : undefined;
  }

  async deleteContactPoint(id: string): Promise<boolean> {
    const result = await this.db.delete(contactPoints).where(eq(contactPoints.id, id)).returning();
    return result.length > 0;
  }

  // — Policy Tree

  async getPolicyTree(): Promise<NotificationPolicyNode> {
    const [row] = await this.db
      .select()
      .from(notificationPolicyTree)
      .where(eq(notificationPolicyTree.id, 'root'));
    if (!row) return defaultPolicyTree();
    return row.tree as NotificationPolicyNode;
  }

  async updatePolicyTree(tree: NotificationPolicyNode): Promise<void> {
    const now = new Date().toISOString();
    const updatedTree = { ...tree, updatedAt: now };
    const existing = await this.db
      .select()
      .from(notificationPolicyTree)
      .where(eq(notificationPolicyTree.id, 'root'));
    if (existing.length > 0) {
      await this.db
        .update(notificationPolicyTree)
        .set({ tree: toJsonColumn(updatedTree), updatedAt: now })
        .where(eq(notificationPolicyTree.id, 'root'));
    } else {
      await this.db
        .insert(notificationPolicyTree)
        .values({ id: 'root', tree: toJsonColumn(updatedTree), updatedAt: now });
    }
  }

  async addChildPolicy(
    parentId: string,
    policy: Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt' | 'updatedAt'>,
  ): Promise<NotificationPolicyNode | undefined> {
    const tree = await this.getPolicyTree();
    const now = new Date().toISOString();

    const newNode: NotificationPolicyNode = {
      ...policy,
      id: randomUUID().slice(0, 12),
      children: [],
      createdAt: now,
      updatedAt: now,
    };

    const parent = this.findNodeById(tree, parentId);
    if (!parent) return undefined;

    parent.children.push(newNode);
    await this.updatePolicyTree(tree);
    return newNode;
  }

  async updatePolicy(
    id: string,
    patch: Partial<Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt'>>,
  ): Promise<NotificationPolicyNode | undefined> {
    const tree = await this.getPolicyTree();
    const node = this.findNodeById(tree, id);
    if (!node) return undefined;

    Object.assign(node, { ...patch, updatedAt: new Date().toISOString() });
    await this.updatePolicyTree(tree);
    return node;
  }

  async deletePolicy(id: string): Promise<boolean> {
    if (id === 'root') return false;
    const tree = await this.getPolicyTree();
    const deleted = this.removeNodeById(tree, id);
    if (deleted) {
      await this.updatePolicyTree(tree);
    }
    return deleted;
  }

  // — Mute Timings

  async createMuteTiming(data: { name: string; timeIntervals: TimeInterval[] }): Promise<MuteTiming> {
    const now = new Date().toISOString();
    const id = `mute_${randomUUID().slice(0, 12)}`;
    const [row] = await this.db
      .insert(muteTimings)
      .values({
        id,
        name: data.name,
        timeIntervals: data.timeIntervals as unknown[],
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToMuteTiming(row!);
  }

  async findAllMuteTimings(): Promise<MuteTiming[]> {
    const rows = await this.db.select().from(muteTimings);
    return rows.map(rowToMuteTiming);
  }

  async findMuteTimingById(id: string): Promise<MuteTiming | undefined> {
    const [row] = await this.db.select().from(muteTimings).where(eq(muteTimings.id, id));
    return row ? rowToMuteTiming(row) : undefined;
  }

  async updateMuteTiming(
    id: string,
    patch: Partial<Omit<MuteTiming, 'id' | 'createdAt'>>,
  ): Promise<MuteTiming | undefined> {
    const sets: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) sets.name = patch.name;
    if (patch.timeIntervals !== undefined) sets.timeIntervals = patch.timeIntervals;
    const [row] = await this.db
      .update(muteTimings)
      .set(sets)
      .where(eq(muteTimings.id, id))
      .returning();
    return row ? rowToMuteTiming(row) : undefined;
  }

  async deleteMuteTiming(id: string): Promise<boolean> {
    const result = await this.db.delete(muteTimings).where(eq(muteTimings.id, id)).returning();
    return result.length > 0;
  }

  // — Routing

  async isMuted(muteTimingIds: string[], now: Date = new Date()): Promise<boolean> {
    const allTimings = await this.findAllMuteTimings();
    const timingsMap = new Map(allTimings.map((mt) => [mt.id, mt]));
    return isMutedByTimings(muteTimingIds, timingsMap as Map<string, MuteTiming>, now);
  }

  async routeAlert(labels: Record<string, string>): Promise<Array<{ contactPointId: string; groupBy: string[]; isMuted: boolean }>> {
    const tree = await this.getPolicyTree();
    const collected: Array<{ contactPointId: string; groupBy: string[]; muteTimingIds: string[] }> = [];
    routeIntoTree(tree, labels, collected);

    const results: Array<{ contactPointId: string; groupBy: string[]; isMuted: boolean }> = [];
    for (const c of collected) {
      const muted = await this.isMuted(c.muteTimingIds);
      results.push({
        contactPointId: c.contactPointId,
        groupBy: c.groupBy,
        isMuted: muted,
      });
    }
    return results;
  }

  // — Private tree helpers

  private findNodeById(node: NotificationPolicyNode, id: string): NotificationPolicyNode | undefined {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = this.findNodeById(child, id);
      if (found) return found;
    }
    return undefined;
  }

  private removeNodeById(node: NotificationPolicyNode, id: string): boolean {
    const idx = node.children.findIndex((c) => c.id === id);
    if (idx !== -1) {
      node.children.splice(idx, 1);
      return true;
    }
    for (const child of node.children) {
      if (this.removeNodeById(child, id)) return true;
    }
    return false;
  }
}
