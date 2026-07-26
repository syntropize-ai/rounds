/**
 * Docs-truth guards.
 *
 * The published docs (docs/ ships to GitHub Pages) and the root markdown had
 * drifted into describing a system that does not exist: unresolved merge
 * conflicts, packages that were deleted or never existed, and environment
 * variables no code reads. These tests fail on each of those classes of lie.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, match));
    else if (match(entry.name)) out.push(path);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Workspace packages that actually exist on disk. */
function realPackages(): Set<string> {
  return new Set(
    readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'packages', e.name, 'package.json')))
      .map((e) => e.name),
  );
}

describe('markdown has no unresolved merge conflicts', () => {
  const files = [
    ...walk(join(ROOT, 'docs'), (n) => n.endsWith('.md')),
    ...readdirSync(ROOT)
      .filter((n) => n.endsWith('.md'))
      .map((n) => join(ROOT, n))
      .filter((p) => statSync(p).isFile()),
  ];

  it.each(files)('%s', (file) => {
    const lines = readFileSync(file, 'utf8').split('\n');
    const markers = lines.filter((l) => /^(<{7}|={7}|>{7})(\s|$)/.test(l));
    expect(markers).toEqual([]);
  });
});

describe('documented packages exist', () => {
  const real = realPackages();

  it('ARCHITECTURE.md responsibility table lists exactly the real packages', () => {
    const documented = [...read('ARCHITECTURE.md').matchAll(/^\|\s*\*\*([a-z-]+)\*\*\s*\|/gm)].map(
      (m) => m[1]!,
    );
    expect(new Set(documented)).toEqual(real);
  });

  it('CONTRIBUTING.md project structure lists exactly the real packages', () => {
    const documented = [...read('CONTRIBUTING.md').matchAll(/^ {2}([a-z-]+)\/\s/gm)].map((m) => m[1]!);
    expect(new Set(documented)).toEqual(real);
  });

  it('docs/architecture.md package layout lists exactly the real packages', () => {
    const block = /```text\n([\s\S]*?)```/.exec(read('docs/architecture.md'));
    expect(block).not.toBeNull();
    const documented = block![1]!.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(new Set(documented)).toEqual(real);
  });
});

describe('documented environment variables are read by the code', () => {
  /** Every env-var name referenced from server source. */
  const referenced: Set<string> = (() => {
    const sources = [
      ...walk(join(ROOT, 'packages'), (n) => n.endsWith('.ts') || n.endsWith('.tsx')),
      ...walk(join(ROOT, 'bin'), (n) => n.endsWith('.ts')),
      join(ROOT, 'packages', 'cli', 'bin', 'rounds.mjs'),
    ];
    const patterns = [
      /process\.env\.([A-Z][A-Z0-9_]*)/g,
      /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
      /\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
      /\benv\.([A-Z][A-Z0-9_]*)/g,
      // envFlag('NAME', …) and friends
      /\w*[eE]nv\w*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    ];
    const found = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const re of patterns) {
        for (const m of text.matchAll(re)) found.add(m[1]!);
      }
    }
    return found;
  })();

  function expectAllReferenced(names: string[]): void {
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !referenced.has(n))).toEqual([]);
  }

  it('.env.example', () => {
    const names = [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    expectAllReferenced(names);
  });

  it('docs/configuration.md', () => {
    const names = [...read('docs/configuration.md').matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map(
      (m) => m[1]!,
    );
    expectAllReferenced(names);
  });

  it('helm values.yaml', () => {
    const names = [...read('helm/rounds/values.yaml').matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map(
      (m) => m[1]!,
    );
    expectAllReferenced(names);
  });

  it('helm configmap template', () => {
    const names = [
      ...read('helm/rounds/templates/configmap.yaml').matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm),
    ].map((m) => m[1]!);
    expectAllReferenced(names);
  });
});

/**
 * Tool names in the docs have to be tool names.
 *
 * The investigations page documented `investigation.create`, `metrics.range_query`
 * and four more that have never existed — the real tools use underscores. Anyone
 * following that page to script against the agent would have failed on every
 * call, and the page had read plausibly for months because nothing compared it
 * to the registry.
 *
 * Hand-checking does not work: fixing that page, I introduced two new wrong
 * names (`metrics_label_values`, `investigation_add_section`) by copying from
 * the very text I was correcting. This test caught both.
 */
describe('documented tool names exist', () => {
  // Two shapes, kept apart on purpose.
  //
  // A dotted name is unambiguously wrong: no tool has ever had a dot, so any
  // `something.something` in backticks is a name that cannot be called.
  //
  // Underscored names are only checked for prefixes that belong exclusively to
  // tools. `dashboard_` and `connector_` are excluded because the docs also use
  // them for tables and permissions — `dashboard_acl` is a real thing that is
  // not a tool, and flagging it would train people to ignore this test.
  const DOTTED = /`([a-z_]+\.[a-z_.]+)`/g;
  const UNDERSCORED = /`((?:metrics|logs|changes|investigation|ops)_[a-z_]+)`/g;

  function registeredToolNames(): Set<string> {
    const registry = read('packages/agent-core/src/agent/tool-schema-registry.ts');
    const names = new Set<string>();
    for (const m of registry.matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)) names.add(m[1]!);
    return names;
  }

  it('finds the registry, so an empty match set cannot pass this silently', () => {
    expect(registeredToolNames().size).toBeGreaterThan(20);
  });

  it('every tool-shaped name in docs/ is a real tool', () => {
    const known = registeredToolNames();
    const wrong: string[] = [];
    for (const file of walk(join(ROOT, 'docs'), (n) => n.endsWith('.md'))) {
      const text = readFileSync(file, 'utf8');
      const where = file.replace(ROOT + '/', '');
      for (const m of text.matchAll(UNDERSCORED)) {
        if (!known.has(m[1]!)) wrong.push(`${where}: ${m[1]}`);
      }
      for (const m of text.matchAll(DOTTED)) {
        const dotted = m[1]!;
        // Only complain when the underscored form is a tool — otherwise this is
        // ordinary prose like `package.json` or `spec.replicas`.
        if (known.has(dotted.replace(/\./g, '_'))) {
          wrong.push(`${where}: ${dotted} (tools use underscores)`);
        }
      }
    }
    expect(wrong, `these are written as tools but are not in the registry:\n${wrong.join('\n')}`).toEqual([]);
  });
});
