import { describe, it, expect } from 'vitest';
import { LintEngine } from './engine.js';
import type { LintRule } from './types.js';
import { mkDashboard, mkPanel } from './rules/__tests__/_fixtures.js';

const ruleA: LintRule = {
  name: 'rule-a',
  description: 'always warns once',
  defaultSeverity: 'warn',
  async check() {
    return [{ severity: 'warn', ruleName: 'rule-a', message: 'A' }];
  },
};
const ruleB: LintRule = {
  name: 'rule-b',
  description: 'always errors once',
  defaultSeverity: 'error',
  async check() {
    return [{ severity: 'error', ruleName: 'rule-b', message: 'B' }];
  },
};
const ruleBoom: LintRule = {
  name: 'rule-boom',
  description: 'throws',
  defaultSeverity: 'info',
  async check() {
    throw new Error('kaboom');
  },
};

describe('LintEngine', () => {
  const spec = mkDashboard([mkPanel({ id: 'p1', description: 'Q: ?' })]);

  it('aggregates issues from every registered rule', async () => {
    const engine = new LintEngine();
    engine.register(ruleA);
    engine.register(ruleB);
    const issues = await engine.run(spec, {});
    expect(issues.map((i) => i.ruleName).sort()).toEqual(['rule-a', 'rule-b']);
  });

  it('honors the `only` filter', async () => {
    const engine = new LintEngine();
    engine.register(ruleA);
    engine.register(ruleB);
    const issues = await engine.run(spec, {}, { only: ['rule-b'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.ruleName).toBe('rule-b');
  });

  it('honors the `skip` filter', async () => {
    const engine = new LintEngine();
    engine.register(ruleA);
    engine.register(ruleB);
    const issues = await engine.run(spec, {}, { skip: ['rule-a'] });
    expect(issues.map((i) => i.ruleName)).toEqual(['rule-b']);
  });

  it('catches rule exceptions and turns them into info issues', async () => {
    const engine = new LintEngine();
    engine.register(ruleA);
    engine.register(ruleBoom);
    const issues = await engine.run(spec, {});
    const boom = issues.find((i) => i.ruleName === 'rule-boom')!;
    expect(boom.severity).toBe('info');
    expect(boom.message).toMatch(/kaboom/);
    // Other rules still ran.
    expect(issues.some((i) => i.ruleName === 'rule-a')).toBe(true);
  });
});
