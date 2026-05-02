import { describe, expect, it } from 'vitest';
import { buildOpsConnectorInput, inspectKubeconfigMetadata, parseNamespaceList } from './ops-api.js';

const baseForm = {
  name: '',
  environment: '',
  clusterName: '',
  namespaces: '',
  kubeconfig: '',
  context: '',
  apiServer: '',
  token: '',
  caData: '',
  insecureSkipTlsVerify: false,
  capabilities: { read: true, propose: false, execute_approved: false } as Record<
    'read' | 'propose' | 'execute_approved',
    boolean
  >,
};

describe('ops-api helpers', () => {
  it('parses namespace lists from commas and newlines', () => {
    expect(parseNamespaceList('default, api\npayments\n\n ops ')).toEqual([
      'default',
      'api',
      'payments',
      'ops',
    ]);
  });

  it('detects current-context and maps it to the matching cluster server/name', () => {
    const metadata = inspectKubeconfigMetadata(`
apiVersion: v1
kind: Config
current-context: prod-admin
clusters:
- name: dev
  cluster:
    server: https://dev.example.com
- name: prod
  cluster:
    server: https://prod.example.com:6443
contexts:
- name: dev-admin
  context:
    cluster: dev
- name: prod-admin
  context:
    cluster: prod
users: []
`);

    expect(metadata).toEqual({
      apiServer: 'https://prod.example.com:6443',
      clusterName: 'prod',
      context: 'prod-admin',
      serverIsLocalhost: false,
      unreachableFromGateway: false,
    });
  });

  it('falls back to the first context and its cluster when current-context is absent', () => {
    const metadata = inspectKubeconfigMetadata(`
clusters:
- name: staging
  cluster:
    server: "https://staging.example.com"
contexts:
- name: staging-admin
  context:
    cluster: staging
`);

    expect(metadata).toMatchObject({
      apiServer: 'https://staging.example.com',
      clusterName: 'staging',
      context: 'staging-admin',
      serverIsLocalhost: false,
      unreachableFromGateway: false,
    });
  });

  it('detects localhost API servers as unreachable from the gateway', () => {
    const metadata = inspectKubeconfigMetadata(`
current-context: local
clusters:
- name: docker-desktop
  cluster:
    server: https://127.0.0.1:6443 # local tunnel
contexts:
- name: local
  context:
    cluster: docker-desktop
`);

    expect(metadata).toMatchObject({
      apiServer: 'https://127.0.0.1:6443',
      clusterName: 'docker-desktop',
      context: 'local',
      serverIsLocalhost: true,
      unreachableFromGateway: true,
    });
  });

  it('kubeconfig mode: forwards pasted YAML as `secret`', () => {
    const out = buildOpsConnectorInput({
      ...baseForm,
      mode: 'kubeconfig',
      name: ' Prod Cluster ',
      environment: ' prod ',
      kubeconfig: ' kubeconfig-yaml ',
      namespaces: 'default,api',
      capabilities: { read: true, propose: true, execute_approved: false },
    });
    expect(out).toMatchObject({
      name: 'Prod Cluster',
      environment: 'prod',
      config: { mode: 'kubeconfig', credentialType: 'kubeconfig' },
      secret: 'kubeconfig-yaml',
      secretRef: null,
      allowedNamespaces: ['default', 'api'],
      capabilities: ['read', 'propose'],
    });
  });

  it('manual mode: sends manual block, no secret', () => {
    const out = buildOpsConnectorInput({
      ...baseForm,
      mode: 'manual',
      name: 'Prod',
      apiServer: 'https://k8s.example.com',
      token: 'tok',
      caData: 'ca-pem',
    });
    expect(out).toMatchObject({
      config: { mode: 'manual', apiServer: 'https://k8s.example.com', credentialType: 'token' },
      secret: null,
      manual: { server: 'https://k8s.example.com', token: 'tok', caData: 'ca-pem' },
    });
  });

  it('in-cluster mode: no secret, no manual', () => {
    const out = buildOpsConnectorInput({
      ...baseForm,
      mode: 'in-cluster',
      name: 'Self',
    });
    expect(out).toMatchObject({
      config: { mode: 'in-cluster' },
      secret: null,
      secretRef: null,
    });
    expect((out as { manual?: unknown }).manual).toBeUndefined();
  });
});
