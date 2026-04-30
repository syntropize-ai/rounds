import { describe, expect, it } from 'vitest';
import {
  classifyKubectlError,
  synthesizeKubeconfig,
  synthesizeInClusterKubeconfig,
  validateKubernetesConnector,
} from './ops-connector-service.js';

describe('synthesizeKubeconfig', () => {
  it('produces a YAML kubeconfig with the expected fields', () => {
    const yaml = synthesizeKubeconfig({
      server: 'https://k8s.example.com:6443',
      token: 'tok-123',
      caData: 'ca-pem-content',
    });
    expect(yaml).toContain('apiVersion: v1');
    expect(yaml).toContain('kind: Config');
    expect(yaml).toContain('server: https://k8s.example.com:6443');
    expect(yaml).toContain('token: tok-123');
    // CA must be base64-encoded for certificate-authority-data.
    const expectedCa = Buffer.from('ca-pem-content', 'utf8').toString('base64');
    expect(yaml).toContain(`certificate-authority-data: ${expectedCa}`);
  });

  it('honors insecureSkipTlsVerify and omits CA', () => {
    const yaml = synthesizeKubeconfig({
      server: 'https://k8s.example.com',
      token: 'tok',
      insecureSkipTlsVerify: true,
    });
    expect(yaml).toContain('insecure-skip-tls-verify: true');
    expect(yaml).not.toContain('certificate-authority-data');
  });
});

describe('synthesizeInClusterKubeconfig', () => {
  it('reads SA token + CA + namespace from injected paths', () => {
    const reads = new Map<string, string>([
      ['/var/run/secrets/kubernetes.io/serviceaccount/token', 'sa-token-xyz\n'],
      ['/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'sa-ca-pem'],
      ['/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'monitoring\n'],
    ]);
    const yaml = synthesizeInClusterKubeconfig({
      readFile: (p) => reads.get(p) ?? '',
      envHost: '10.0.0.1',
      envPort: '443',
    });
    expect(yaml).toContain('server: https://10.0.0.1:443');
    expect(yaml).toContain('token: sa-token-xyz');
    expect(yaml).toContain('namespace: monitoring');
  });
});

describe('classifyKubectlError', () => {
  it.each([
    ['x509: certificate signed by unknown authority', false, /TLS error/i],
    ['Unauthorized', false, /401/],
    ['error: forbidden', false, /403/],
    ['dial tcp: lookup foo.bar: no such host', false, /DNS/i],
    ['', true, /timeout/i],
  ])('classifies %s', (stderr, timedOut, expected) => {
    expect(classifyKubectlError(stderr, timedOut)).toMatch(expected);
  });
});

describe('validateKubernetesConnector', () => {
  it('accepts in-cluster mode without apiServer/clusterName/context', () => {
    expect(validateKubernetesConnector({ mode: 'in-cluster' } as never)).toBeNull();
  });

  it('still requires one of the identifiers in non-in-cluster modes', () => {
    expect(validateKubernetesConnector({})).toMatch(/required/);
  });
});
