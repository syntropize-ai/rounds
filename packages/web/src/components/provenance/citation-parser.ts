/**
 * Inline citation parser for AI-generated markdown (Task 10).
 *
 * Recognised tokens look like `[m1]`, `[l2]`, `[k3]`, `[c1]` — the leading
 * letter encodes evidence kind (m=metric, l=log, k=k8s, c=change), the
 * number disambiguates within a single report. The parser splits a string
 * into alternating `text` and `citation` runs so the caller can render
 * chips while leaving everything else untouched. It MUST NOT consume
 * other markdown features (links, code spans, bold) — `<InlineMarkdown>`
 * runs the citation pass first and then re-applies its own bold/code
 * passes on the surviving text runs.
 */

import type { CitationKind } from '@agentic-obs/common';

export interface CitationToken {
  ref: string;
  kind: CitationKind;
}

export type CitationRun =
  | { type: 'text'; text: string }
  | { type: 'citation'; ref: string; kind: CitationKind };

const CITATION_RX = /\[([mlkc])(\d+)\]/g;
const KIND_BY_PREFIX: Record<string, CitationKind> = {
  m: 'metric',
  l: 'log',
  k: 'k8s',
  c: 'change',
};

/** Split a string into alternating text / citation runs. */
export function parseCitations(source: string): CitationRun[] {
  const runs: CitationRun[] = [];
  let lastIndex = 0;
  for (const m of source.matchAll(CITATION_RX)) {
    const start = m.index ?? 0;
    if (start > lastIndex) {
      runs.push({ type: 'text', text: source.slice(lastIndex, start) });
    }
    const prefix = m[1]!;
    runs.push({
      type: 'citation',
      ref: `${prefix}${m[2]!}`,
      kind: KIND_BY_PREFIX[prefix]!,
    });
    lastIndex = start + m[0].length;
  }
  if (lastIndex < source.length) {
    runs.push({ type: 'text', text: source.slice(lastIndex) });
  }
  return runs;
}
