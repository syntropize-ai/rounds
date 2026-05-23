import { describe, it, expect } from 'vitest';
import { capabilityKind } from './capability-kind.js';

describe('capabilityKind', () => {
  it('classifies canonical read verbs', () => {
    expect(capabilityKind('metrics.query')).toBe('read');
    expect(capabilityKind('metrics.discover')).toBe('read');
    expect(capabilityKind('runtime.list')).toBe('read');
    expect(capabilityKind('runtime.get')).toBe('read');
    expect(capabilityKind('logs.stream')).toBe('read');
    expect(capabilityKind('metrics.validate')).toBe('read');
    expect(capabilityKind('config.read')).toBe('read');
  });

  it('classifies common write verbs', () => {
    expect(capabilityKind('runtime.apply')).toBe('write');
    expect(capabilityKind('runtime.exec')).toBe('write');
    expect(capabilityKind('runtime.delete')).toBe('write');
    expect(capabilityKind('runtime.scale')).toBe('write');
    expect(capabilityKind('runtime.port_forward')).toBe('write');
  });

  it('treats deeper namespaced capabilities by their first verb segment', () => {
    // `cluster_shell` is not a read verb → write.
    expect(capabilityKind('runtime.cluster_shell.cluster')).toBe('write');
    expect(capabilityKind('runtime.cluster_shell.namespace')).toBe('write');
  });

  it('defaults to write for malformed or unknown input', () => {
    expect(capabilityKind('')).toBe('write');
    expect(capabilityKind('runtime')).toBe('write');
    expect(capabilityKind('something.weird')).toBe('write');
  });
});
