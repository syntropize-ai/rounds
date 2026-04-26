import type { OpsConnector, OpsConnectorConfig, OpsConnectorStatus } from '@agentic-obs/data-layer';
import { DefaultOpsSecretRefResolver, type OpsSecretRefResolver } from './ops-secret-ref-resolver.js';

export interface OpsConnectorTestResult {
  status: Exclude<OpsConnectorStatus, 'unknown'>;
  checks: {
    structure: 'ok' | 'failed';
    credentials: 'ok' | 'missing';
    runner: 'skipped';
  };
  message: string;
}

export interface KubernetesConnectorRunner {
  test(connector: OpsConnector): Promise<OpsConnectorTestResult>;
}

export class StructuralKubernetesConnectorRunner implements KubernetesConnectorRunner {
  private readonly secretResolver: OpsSecretRefResolver;

  constructor(secretResolver: OpsSecretRefResolver = new DefaultOpsSecretRefResolver()) {
    this.secretResolver = secretResolver;
  }

  async test(connector: OpsConnector): Promise<OpsConnectorTestResult> {
    const validation = validateKubernetesConnector(connector.config);
    if (validation) {
      return {
        status: 'error',
        checks: { structure: 'failed', credentials: 'missing', runner: 'skipped' },
        message: validation,
      };
    }

    const hasCredentials = Boolean(connector.secretRef || connector.secret);
    if (connector.secretRef) {
      try {
        await this.secretResolver.resolve(connector.secretRef);
      } catch (err) {
        return {
          status: 'error',
          checks: { structure: 'ok', credentials: 'missing', runner: 'skipped' },
          message: `Kubernetes connector structure is valid, but secretRef could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return {
      status: hasCredentials ? 'connected' : 'degraded',
      checks: {
        structure: 'ok',
        credentials: hasCredentials ? 'ok' : 'missing',
        runner: 'skipped',
      },
      message: hasCredentials
        ? 'Kubernetes connector structure is valid; live cluster probe is not enabled yet.'
        : 'Kubernetes connector structure is valid, but no secret or secretRef is configured.',
    };
  }
}

export function validateKubernetesConnector(config: OpsConnectorConfig): string | null {
  const apiServer = config.apiServer;
  if (apiServer !== undefined && typeof apiServer !== 'string') {
    return 'config.apiServer must be a string when provided';
  }
  if (typeof apiServer === 'string' && apiServer.length > 0) {
    try {
      const parsed = new URL(apiServer);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return 'config.apiServer must use http or https';
      }
    } catch {
      return 'config.apiServer must be a valid URL';
    }
  }

  if (config.clusterName !== undefined && typeof config.clusterName !== 'string') {
    return 'config.clusterName must be a string when provided';
  }
  if (config.context !== undefined && typeof config.context !== 'string') {
    return 'config.context must be a string when provided';
  }
  if (!config.apiServer && !config.clusterName && !config.context) {
    return 'one of config.apiServer, config.clusterName, or config.context is required';
  }

  return null;
}
