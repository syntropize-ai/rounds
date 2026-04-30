import { describe, expect, it } from 'vitest';
import { buildOpsConnectorInput, parseNamespaceList } from './ops-api.js';

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
