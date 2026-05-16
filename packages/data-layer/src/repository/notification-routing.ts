import type {
  NotificationPolicyNode,
  MuteTiming,
  TimeInterval,
} from '@agentic-obs/common';

// -- Label matching helpers

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

export function nodeMatchesLabels(
  node: NotificationPolicyNode,
  labels: Record<string, string>,
): boolean {
  return node.matchers.every((m) => matchesLabel(labels[m.label], m.operator, m.value));
}

// Walk the tree depth-first and collect all matching policies
export function walkTree(
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
export function routeIntoTree(
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

export function intervalActive(interval: TimeInterval, now: Date): boolean {
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

/**
 * Check if any of the given mute timing IDs are currently active.
 */
export function isMutedByTimings(
  muteTimingIds: string[],
  muteTimingsMap: Map<string, MuteTiming>,
  now: Date = new Date(),
): boolean {
  for (const id of muteTimingIds) {
    const mt = muteTimingsMap.get(id);
    if (!mt)
      continue;
    for (const interval of mt.timeIntervals) {
      if (intervalActive(interval, now))
        return true;
    }
  }
  return false;
}
