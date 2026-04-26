import { describe, expect, it } from 'vitest';
import { buildOpsConnectorInput, parseNamespaceList } from './ops-api.js';

describe('ops-api helpers', () => {
  it('parses namespace lists from commas and newlines', () => {
    expect(parseNamespaceList('default, api\npayments\n\n ops ')).toEqual([
      'default',
      'api',
      'payments',
      'ops',
    ]);
  });

  it('builds a connector payload without inventing defaults beyond checked capabilities', () => {
    expect(buildOpsConnectorInput({
      name: ' Prod Cluster ',
      environment: ' prod ',
      apiServer: ' https://k8s.example.com ',
      clusterName: '',
      context: '',
      namespaces: 'default,api',
      kubeconfig: ' kubeconfig-yaml ',
      token: '',
      secretRef: '',
      capabilities: {
        read: true,
        propose: true,
        execute_approved: false,
      },
    })).toEqual({
      name: 'Prod Cluster',
      environment: 'prod',
      config: {
        apiServer: 'https://k8s.example.com',
        clusterName: undefined,
        context: undefined,
        credentialType: 'kubeconfig',
      },
      allowedNamespaces: ['default', 'api'],
      secretRef: null,
      secret: 'kubeconfig-yaml',
      capabilities: ['read', 'propose'],
    });
  });

  it('prefers secretRef over pasted credentials', () => {
    expect(buildOpsConnectorInput({
      name: 'Prod',
      environment: '',
      apiServer: '',
      clusterName: 'prod',
      context: '',
      namespaces: '',
      kubeconfig: ' kubeconfig-yaml ',
      token: '',
      secretRef: ' env://OPENOBS_KUBECONFIG_PROD ',
      capabilities: {
        read: true,
        propose: false,
        execute_approved: false,
      },
    })).toMatchObject({
      secretRef: 'env://OPENOBS_KUBECONFIG_PROD',
      secret: null,
      capabilities: ['read'],
    });
  });
});
