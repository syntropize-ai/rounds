import { randomUUID } from 'crypto';
import type {
  ContactPoint,
  ContactPointIntegration,
  NotificationPolicyNode,
  MuteTiming,
  TimeInterval,
} from '@agentic-obs/common';
import type { Persistable } from '../persistence.js';
import { markDirty } from '../persistence.js';

// -- Helpers

function matchesLabel(
  labelValue: string | undefined,
  operator: string,
  matchValue: string,
): boolean {
  const v = labelValue ?? '';
  switch (operator) {
    case '=':
      return v === matchValue;
    case '!=':
      return v !== matchValue;
    case '=~':
      return new RegExp(matchValue).test(v);
    case '!~':
      return !new RegExp(matchValue).test(v);
    default:
      return false;
  }
}

function nodeMatchesLabels(
  node: NotificationPolicyNode,
  labels: Record<string, string>,
): boolean {
  return node.matchers.every((m) => matchesLabel(labels[m.label], m.operator, m.value));
}

// Walk the tree depth-first and collect all matching policies
function walkTree(
  node: NotificationPolicyNode,
  labels: Record<string, string>,
  results: Array<{ node: NotificationPolicyNode; matched: boolean }>,
): void {
  const isRoot = node.isDefault === true;
  const matches = isRoot ? true : nodeMatchesLabels(node, labels);

  if (matches) {
    results.push({ node, matched: true });
    // Children refine matches; they are sub-policies of this match
    for (const child of node.children)
      walkTree(child, labels, results);
  }
}

// Collect matching contact points via proper Grafana-style routing:
// Start at root (always matches), recurse into children,
// a branch stops descending once a child matches and continueMatching is false.
function routeIntoTree(
  node: NotificationPolicyNode,
  labels: Record<string, string>,
  collected: Array<{ contactPointId: string; groupBy: string[]; muteTimingIds: string[] }>,
): boolean {
  const isRoot = node.isDefault === true;
  const matches = isRoot ? true : nodeMatchesLabels(node, labels);

  if (!matches)
    return false;

  // Check children first (more-specific policies)
  let childMatched = false;
  for (const child of node.children) {
    const hit = routeIntoTree(child, labels, collected);
    if (hit) {
      childMatched = true;
      // if the child does not continue matching we stop after it
      if (!child.continueMatching)
        break;
    }
  }

  // If no child matched OR this is the root we add this node's contact point.
  if (!childMatched || isRoot) {
    if (node.contactPointId) {
      collected.push({
        contactPointId: node.contactPointId,
        groupBy: node.groupBy ?? [],
        muteTimingIds: node.muteTimingIds ?? [],
      });
    }
  }

  return true;
}

// -- Time-interval helpers

function minuteOfDay(d: Date, tz: string): number {
  // Convert to the target timezone and extract hour/minute
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(d);

  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return hour * 60 + minute;
}

function localDateParts(d: Date, tz: string): { weekday: number; day: number; month: number; year: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(d);

  const weekdayStr = fmt.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[weekdayStr] ?? 0;
  const day = parseInt(fmt.find((p) => p.type === 'day')?.value ?? '1', 10);
  const month = parseInt(fmt.find((p) => p.type === 'month')?.value ?? '1', 10);
  const year = parseInt(fmt.find((p) => p.type === 'year')?.value ?? '2024', 10);

  return { weekday, day, month, year };
}

function intervalActive(interval: TimeInterval, now: Date): boolean {
  const tz = interval.location ?? 'UTC';
  const { weekday, day, month, year } = localDateParts(now, tz);

  if (interval.years && interval.years.length > 0) {
    if (!interval.years.includes(year))
      return false;
  }
  if (interval.months && interval.months.length > 0) {
    if (!interval.months.includes(month))
      return false;
  }
  if (interval.weekdays && interval.weekdays.length > 0) {
    if (!interval.weekdays.includes(weekday))
      return false;
  }
  if (interval.daysOfMonth && interval.daysOfMonth.length > 0) {
    // Supports negative indices (from end of month)
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const normalized = interval.daysOfMonth.map((d) => (d < 0 ? daysInMonth + d + 1 : d));
    if (!normalized.includes(day))
      return false;
  }

  if (interval.timesOfDay && interval.timesOfDay.length > 0) {
    const current = minuteOfDay(now, tz);
    const inRange = interval.timesOfDay.some((r) => current >= r.startMinute && current <= r.endMinute);
    if (!inRange)
      return false;
  }

  return true;
}

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
    for (const id of muteTimingIds) {
      const mt = this.muteTimings.get(id);
      if (!mt)
        continue;
      for (const interval of mt.timeIntervals) {
        if (intervalActive(interval, now))
          return true;
      }
    }
    return false;
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
