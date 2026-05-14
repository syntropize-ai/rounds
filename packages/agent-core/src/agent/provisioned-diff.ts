/**
 * Wave 2 / Step 5 — provisioned-resource diff helper.
 *
 * When the agent (or a REST caller) tries to mutate a `provisioned_file` /
 * `provisioned_git` resource, the writable-gate throws. Instead of just
 * surfacing the 409 to the user, the orchestrator catches the error and asks
 * this helper for a markdown diff describing the change it would have made to
 * the underlying file. The user can then commit the diff in their git repo
 * (Phase 1 — no inbound GitHub API yet, see AGENT.md for the constraint).
 *
 * Phase 2 (real PR creation against the source repo) is intentionally out of
 * scope; this helper exists so the chat panel can render a copy-paste diff +
 * a "Fork to my workspace" button without round-tripping to the LLM.
 */

import type { ResourceProvenance } from '@agentic-obs/common';

export interface ProvisionedDiffProvenance {
  repo?: string;
  path?: string;
  commit?: string;
}

/**
 * Produce a markdown-formatted diff suitable for chat display. The output is
 * a fenced ```diff block followed by a short "how to apply" footer.
 *
 * The "before" and "after" values are serialised as JSON (sorted keys, 2-space
 * indent) and a per-line `-`/`+` prefix is applied. This is a structural diff
 * rather than a full unified diff — the underlying provisioned file is most
 * often YAML, but the agent operates on the normalised in-memory JSON shape;
 * a JSON diff is precise enough for the user to translate into their YAML
 * edit without us having to reach for the original file representation.
 */
export function generateProvisionedDiff(
  before: Record<string, unknown>,
  after: Partial<Record<string, unknown>>,
  provenance: ProvisionedDiffProvenance | ResourceProvenance | undefined,
): string {
  const beforeStr = stableStringify(before, 2);
  // Merge before+after so the diff includes context for the unchanged fields
  // around the mutation. Without this the diff is a tiny island with no clue
  // which resource it belongs to once pasted into a PR description.
  const merged = { ...before, ...after };
  const afterStr = stableStringify(merged, 2);

  const diffBody = lineDiff(beforeStr, afterStr);

  const repo = provenance?.repo;
  const path = provenance?.path;
  const commit = provenance?.commit;
  const target =
    repo && path
      ? `\`${repo}/${path}\`${commit ? ` (at \`${commit.slice(0, 7)}\`)` : ''}`
      : path
        ? `\`${path}\``
        : 'the source file';

  return [
    `This resource is managed by git (\`${path ?? 'provisioned file'}\`). The agent could not apply the change directly. Here is the diff it would have applied:`,
    '',
    '```diff',
    diffBody,
    '```',
    '',
    `**To apply:** commit this diff to ${target} and re-run your GitOps sync. Alternatively, use \`Fork to my workspace\` to copy this resource into your personal folder where you can edit freely.`,
  ].join('\n');
}

/**
 * Minimal line-by-line diff: lines present in `before` not in `after` are
 * prefixed `-`, lines present in `after` not in `before` are prefixed `+`,
 * common lines are prefixed with two spaces. We do NOT compute a longest-
 * common-subsequence — for the structural-JSON case the inputs share most
 * lines verbatim and the naive same-index walk produces a readable diff. If
 * future use-cases need true LCS we can swap in a library; today's caller is
 * "show what changed in a small JSON object" and this is enough.
 */
function lineDiff(beforeStr: string, afterStr: string): string {
  const beforeLines = beforeStr.split('\n');
  const afterLines = afterStr.split('\n');
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const out: string[] = [];
  // Walk the longer of the two so we don't drop trailing additions.
  const len = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < len; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      if (b !== undefined) out.push(`  ${b}`);
      continue;
    }
    if (b !== undefined && !afterSet.has(b)) out.push(`- ${b}`);
    if (a !== undefined && !beforeSet.has(a)) out.push(`+ ${a}`);
  }
  return out.join('\n');
}

/** JSON.stringify with deterministic key order so diffs are stable. */
function stableStringify(value: unknown, indent: number): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  }, indent);
}
