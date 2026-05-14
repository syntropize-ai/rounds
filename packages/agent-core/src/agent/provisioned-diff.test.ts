import { describe, it, expect } from 'vitest';
import { generateProvisionedDiff } from './provisioned-diff.js';

describe('generateProvisionedDiff', () => {
  it('produces a fenced markdown diff block with - and + lines', () => {
    const before = { title: 'old', threshold: 5 };
    const after = { threshold: 10 };
    const out = generateProvisionedDiff(before, after, {
      repo: 'org/repo',
      path: 'alerts/cpu.yaml',
      commit: 'abc1234',
    });
    expect(out).toContain('```diff');
    expect(out).toContain('```');
    // The threshold line changed: 5 → 10
    expect(out).toMatch(/-\s+"threshold":\s*5/);
    expect(out).toMatch(/\+\s+"threshold":\s*10/);
    // Title is unchanged — should appear with two-space prefix (context).
    expect(out).toMatch(/\s\s\s+"title":\s*"old"/);
  });

  it('renders the apply footer with repo + short commit', () => {
    const out = generateProvisionedDiff(
      { x: 1 },
      { x: 2 },
      { repo: 'org/repo', path: 'a.yaml', commit: 'abcdef1234' },
    );
    expect(out).toContain('To apply:');
    expect(out).toContain('`org/repo/a.yaml`');
    expect(out).toContain('`abcdef1`'); // short commit
  });

  it('still produces a diff when no provenance is given', () => {
    const out = generateProvisionedDiff({ x: 1 }, { x: 2 }, undefined);
    expect(out).toContain('```diff');
    expect(out).toContain('the source file');
  });

  it('mentions the Fork-to-my-workspace alternative', () => {
    const out = generateProvisionedDiff({ x: 1 }, { x: 2 }, { path: 'a.yaml' });
    expect(out).toContain('Fork to my workspace');
  });
});
