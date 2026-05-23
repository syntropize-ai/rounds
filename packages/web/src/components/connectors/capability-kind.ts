/**
 * Classify a capability string as a `read` or `write` operation.
 *
 * The capability shape is `<area>.<verb>` (e.g. `metrics.query`,
 * `runtime.apply`). The verb after the dot is the load-bearing token —
 * everything else (area name, sub-segments) is ignored.
 *
 * A capability is `read` if its verb is one of the canonical read verbs.
 * Anything else (including unknown / malformed input) is `write`. We bias
 * toward `write` because the permissions table uses this classification to
 * surface dangerous capabilities — false-positive writes are loud but safe,
 * false-positive reads are silent and bad.
 */
const READ_VERBS = new Set([
  'query',
  'discover',
  'list',
  'get',
  'stream',
  'validate',
  'read',
]);

export function capabilityKind(cap: string): 'read' | 'write' {
  const dot = cap.indexOf('.');
  if (dot < 0) return 'write';
  // The verb is the segment immediately after the first dot. For deeper
  // capabilities like `runtime.cluster_shell.cluster` the verb is
  // `cluster_shell` — not a read verb, so they fall through to `write`.
  const rest = cap.slice(dot + 1);
  const nextDot = rest.indexOf('.');
  const verb = nextDot < 0 ? rest : rest.slice(0, nextDot);
  return READ_VERBS.has(verb) ? 'read' : 'write';
}
