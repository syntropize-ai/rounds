import { describe, expect, it } from 'vitest';
import { assertWritable, ProvisionedResourceError, type ResourceSource } from './writable-gate.js';

describe('assertWritable', () => {
  const writable: ResourceSource[] = ['manual', 'api', 'ai_generated'];
  const provisioned: ResourceSource[] = ['provisioned_file', 'provisioned_git'];

  for (const source of writable) {
    it(`passes for source=${source}`, () => {
      expect(() =>
        assertWritable({ kind: 'dashboard', id: 'd1', source }),
      ).not.toThrow();
    });
  }

  for (const source of provisioned) {
    it(`throws ProvisionedResourceError for source=${source}`, () => {
      let thrown: unknown;
      try {
        assertWritable({ kind: 'dashboard', id: 'd1', source });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ProvisionedResourceError);
      const err = thrown as ProvisionedResourceError;
      expect(err.resource.source).toBe(source);
      expect(err.message).toContain('Cannot mutate provisioned resource');
      expect(err.message).toContain('dashboard:d1');
      expect(err.message).toContain('Fork to your workspace');
    });
  }
});
