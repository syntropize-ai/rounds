// Alert fingerprint helper — server-only (uses node:crypto).
//
// Consumers use this hash as an idempotency / grouping key:
// the same rule + same label set should always produce the same
// fingerprint regardless of label insertion order.

import { createHash } from 'node:crypto';

export function computeAlertFingerprint(
  ruleId: string,
  labels: Record<string, string>,
): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
  return createHash('sha256').update(`${ruleId}|${sorted}`).digest('hex');
}
