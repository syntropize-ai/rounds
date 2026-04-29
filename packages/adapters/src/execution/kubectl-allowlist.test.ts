import { describe, it, expect } from 'vitest';
import { checkKubectl, parseKubectlArgv } from './kubectl-allowlist.js';

describe('parseKubectlArgv', () => {
  it('extracts verb and namespace from -n', () => {
    const p = parseKubectlArgv(['get', 'pods', '-n', 'app']);
    expect(p.verb).toBe('get');
    expect(p.subResource).toBe('pods');
    expect(p.namespace).toBe('app');
  });
  it('extracts verb and namespace from --namespace=', () => {
    const p = parseKubectlArgv(['get', 'pods', '--namespace=app']);
    expect(p.namespace).toBe('app');
  });
  it('detects auth can-i --as=', () => {
    const p = parseKubectlArgv(['auth', 'can-i', 'list', 'pods', '--as=admin']);
    expect(p.hasAuthCanIAs).toBe(true);
  });
  it('does not flag stray --as on unrelated commands', () => {
    const p = parseKubectlArgv(['get', 'pods', '--as=admin']);
    expect(p.hasAuthCanIAs).toBe(false);
  });
  it('captures resource name for delete', () => {
    const p = parseKubectlArgv(['delete', 'pod', 'web-abc', '-n', 'app']);
    expect(p.resourceName).toBe('web-abc');
  });
});

describe('checkKubectl — read mode', () => {
  it('allows kubectl get pods -n app', () => {
    expect(checkKubectl(['get', 'pods', '-n', 'app'], 'read', ['app']).allow).toBe(true);
  });
  it('allows cluster-scoped reads', () => {
    expect(checkKubectl(['get', 'nodes'], 'read', ['app']).allow).toBe(true);
  });
  it('rejects kubectl exec', () => {
    const d = checkKubectl(['exec', '-it', 'web-abc', '--', 'sh'], 'read', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/permanently denied/);
  });
  it('rejects writes in read mode', () => {
    const d = checkKubectl(['scale', 'deploy/web', '--replicas=3', '-n', 'app'], 'read', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/read-allowlist/);
  });
  it('rejects out-of-allowlist namespace on read', () => {
    const d = checkKubectl(['get', 'pods', '-n', 'kube-system'], 'read', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/not in the connector's allowed namespaces/);
  });
  it('skips namespace gate when allowedNamespaces is empty', () => {
    expect(checkKubectl(['get', 'pods', '-n', 'app'], 'read', []).allow).toBe(true);
  });
});

describe('checkKubectl — write mode', () => {
  it('allows kubectl scale -n app', () => {
    expect(checkKubectl(['scale', 'deploy/web', '--replicas=3', '-n', 'app'], 'write', ['app']).allow).toBe(true);
  });
  it('allows reads in write mode', () => {
    expect(checkKubectl(['get', 'pods', '-n', 'app'], 'write', ['app']).allow).toBe(true);
  });
  it('rejects unknown verbs', () => {
    const d = checkKubectl(['drain', 'node-1'], 'write', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/write-allowlist/);
  });
  it('refuses writes without a namespace', () => {
    const d = checkKubectl(['apply', '-f', 'cm.yaml'], 'write', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/requires --namespace/);
  });
  it('rejects writes to kube-system even when allowed', () => {
    const d = checkKubectl(['patch', 'cm/coredns', '-n', 'kube-system', '-p', '{}'], 'write', ['kube-system']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/permanently denied/);
  });
  it('rejects bare `kubectl delete` without name', () => {
    const d = checkKubectl(['delete', 'pods', '-n', 'app'], 'write', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/explicit resource name/);
  });
  it('allows `kubectl delete pod web-abc -n app`', () => {
    expect(checkKubectl(['delete', 'pod', 'web-abc', '-n', 'app'], 'write', ['app']).allow).toBe(true);
  });
  it('rejects out-of-allowlist namespace on write', () => {
    const d = checkKubectl(['scale', 'deploy/web', '-n', 'other', '--replicas=3'], 'write', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/not in the connector's allowed namespaces/);
  });
  it('permanent-deny wins over write-allowlist', () => {
    const d = checkKubectl(['exec', 'web', '-n', 'app', '--', 'sh'], 'write', ['app']);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/permanently denied/);
  });
});

describe('checkKubectl — permanent denies', () => {
  it('blocks port-forward', () => {
    expect(checkKubectl(['port-forward', 'svc/web', '8080:80', '-n', 'app'], 'write', ['app']).allow).toBe(false);
  });
  it('blocks proxy', () => {
    expect(checkKubectl(['proxy'], 'write', []).allow).toBe(false);
  });
  it('blocks attach', () => {
    expect(checkKubectl(['attach', 'web-abc', '-n', 'app'], 'write', ['app']).allow).toBe(false);
  });
  it('blocks auth can-i --as', () => {
    expect(checkKubectl(['auth', 'can-i', 'create', 'pods', '--as=admin'], 'write', []).allow).toBe(false);
  });
  it('blocks cp', () => {
    expect(checkKubectl(['cp', 'web-abc:/etc/passwd', '/tmp/x', '-n', 'app'], 'write', ['app']).allow).toBe(false);
  });
});
