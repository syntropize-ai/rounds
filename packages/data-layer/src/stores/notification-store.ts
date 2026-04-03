import { randomUUID } from 'crypto';
import type {
  ContactPoint,
  ContactPointIntegration,
  NotificationPolicyNode,
  MuteTiming,
  TimeInterval,
} from '@agentic-obs/common';
import type { Persistable } from './persistence.js';
import { markDirty } from './persistence.js';
import { routeIntoTree, isMutedByTimings } from './notification-dispatch.js';

// -- Store

export class NotificationStore implements Persistable {
  private contactPoints = new Map<string, ContactPoint>();
  private policyTree: NotificationPolicyNode;
  private muteTimings = new Map<string, MuteTiming>();

  constructor() {
    const now = new Date().toISOString();
    this.policyTree = {
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

  // -- Contact Points

  createContactPoint(data: { name: string; integrations: ContactPointIntegration[] }): ContactPoint {
    const now = new Date().toISOString();
    const cp: ContactPoint = {
      id: `cp_${randomUUID().slice(0, 12)}`,
      name: data.name,
      integrations: data.integrations,
      createdAt: now,
      updatedAt: now,
    };
    this.contactPoints.set(cp.id, cp);
    markDirty();
    return cp;
  }

  findAllContactPoints(): ContactPoint[] {
    return [...this.contactPoints.values()];
  }

  findContactPointById(id: string): ContactPoint | undefined {
    return this.contactPoints.get(id);
  }

  updateContactPoint(
    id: string,
    patch: Partial<Omit<ContactPoint, 'id' | 'createdAt'>>,
  ): ContactPoint | undefined {
    const cp = this.contactPoints.get(id);
    if (!cp)
      return undefined;
    const updated: ContactPoint = { ...cp, ...patch, updatedAt: new Date().toISOString() };
    this.contactPoints.set(id, updated);
    markDirty();
    return updated;
  }

  deleteContactPoint(id: string): boolean {
    const result = this.contactPoints.delete(id);
    if (result)
      markDirty();
    return result;
  }

  // -- Policy Tree

  getPolicyTree(): NotificationPolicyNode {
    return this.policyTree;
  }

  updatePolicyTree(tree: NotificationPolicyNode): void {
    this.policyTree = { ...tree, updatedAt: new Date().toISOString() };
    markDirty();
  }

  addChildPolicy(
    parentId: string,
    policy: Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt' | 'updatedAt'>,
  ): NotificationPolicyNode | undefined {
    const newNode: NotificationPolicyNode = {
      ...policy,
      id: randomUUID().slice(0, 12),
      children: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const parent = this.findNodeById(this.policyTree, parentId);
    if (!parent)
      return undefined;

    parent.children.push(newNode);
    this.policyTree = { ...this.policyTree, updatedAt: new Date().toISOString() };
    markDirty();
    return newNode;
  }

  updatePolicy(
    id: string,
    patch: Partial<Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt'>>,
  ): NotificationPolicyNode | undefined {
    const node = this.findNodeById(this.policyTree, id);
    if (!node)
      return undefined;
    const now = new Date().toISOString();
    Object.assign(node, { ...patch, updatedAt: now });
    this.policyTree = { ...this.policyTree, updatedAt: now };
    markDirty();
    return node;
  }

  deletePolicy(id: string): boolean {
    if (id === 'root')
      return false;
    const deleted = this.removeNodeById(this.policyTree, id);
    if (deleted) {
      this.policyTree = { ...this.policyTree, updatedAt: new Date().toISOString() };
      markDirty();
    }
    return deleted;
  }

  // -- Mute Timings

  createMuteTiming(data: { name: string; timeIntervals: TimeInterval[] }): MuteTiming {
    const now = new Date().toISOString();
    const mt: MuteTiming = {
      id: `mute_${randomUUID().slice(0, 12)}`,
      name: data.name,
      timeIntervals: data.timeIntervals,
      createdAt: now,
      updatedAt: now,
    };
    this.muteTimings.set(mt.id, mt);
    markDirty();
    return mt;
  }

  findAllMuteTimings(): MuteTiming[] {
    return [...this.muteTimings.values()];
  }

  findMuteTimingById(id: string): MuteTiming | undefined {
    return this.muteTimings.get(id);
  }

  updateMuteTiming(
    id: string,
    patch: Partial<Omit<MuteTiming, 'id' | 'createdAt'>>,
  ): MuteTiming | undefined {
    const mt = this.muteTimings.get(id);
    if (!mt)
      return undefined;
    const updated: MuteTiming = { ...mt, ...patch, updatedAt: new Date().toISOString() };
    this.muteTimings.set(id, updated);
    markDirty();
    return updated;
  }

  deleteMuteTiming(id: string): boolean {
    const result = this.muteTimings.delete(id);
    if (result)
      markDirty();
    return result;
  }

  // -- Mute timing evaluation

  isMuted(muteTimingIds: string[], now: Date = new Date()): boolean {
    return isMutedByTimings(muteTimingIds, this.muteTimings, now);
  }

  // -- Alert routing

  routeAlert(labels: Record<string, string>): Array<{ contactPointId: string; groupBy: string[]; isMuted: boolean }> {
    const collected: Array<{ contactPointId: string; groupBy: string[]; muteTimingIds: string[] }> = [];
    routeIntoTree(this.policyTree, labels, collected);

    return collected.map((c) => ({
      contactPointId: c.contactPointId,
      groupBy: c.groupBy,
      isMuted: this.isMuted(c.muteTimingIds),
    }));
  }

  // -- Persistable

  toJSON(): unknown {
    return {
      contactPoints: [...this.contactPoints.values()],
      policyTree: this.policyTree,
      muteTimings: [...this.muteTimings.values()],
    };
  }

  loadJSON(data: unknown): void {
    const d = data as Record<string, unknown>;

    if (Array.isArray(d['contactPoints'])) {
      for (const cp of d['contactPoints'] as ContactPoint[]) {
        if (cp.id)
          this.contactPoints.set(cp.id, cp);
      }
    }

    if (d['policyTree'] && typeof d['policyTree'] === 'object') {
      this.policyTree = d['policyTree'] as NotificationPolicyNode;
    }

    if (Array.isArray(d['muteTimings'])) {
      for (const mt of d['muteTimings'] as MuteTiming[]) {
        if (mt.id)
          this.muteTimings.set(mt.id, mt);
      }
    }
  }

  // -- Private tree helpers --

  private findNodeById(
    node: NotificationPolicyNode,
    id: string,
  ): NotificationPolicyNode | undefined {
    if (node.id === id)
      return node;
    for (const child of node.children) {
      const found = this.findNodeById(child, id);
      if (found)
        return found;
    }
    return undefined;
  }

  private removeNodeById(
    node: NotificationPolicyNode,
    id: string,
  ): boolean {
    const idx = node.children.findIndex((c) => c.id === id);
    if (idx !== -1) {
      node.children.splice(idx, 1);
      return true;
    }

    for (const child of node.children) {
      if (this.removeNodeById(child, id))
        return true;
    }

    return false;
  }
}

export const defaultNotificationStore = new NotificationStore();
