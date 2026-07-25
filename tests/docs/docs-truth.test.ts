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
