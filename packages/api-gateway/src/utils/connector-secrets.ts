import type { Connector } from '@agentic-obs/common';

/**
 * Subset of `IConnectorRepository` used for secret resolution. Kept narrow so
 * callers can pass a full repo or any object that exposes `getSecret`.
 */
export interface ConnectorSecretReader {
  getSecret(connectorId: string): Promise<{ ciphertext: Uint8Array } | null>;
}

function inlineApiKey(connector: Connector): string | undefined {
  const value = connector.config['apiKey'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Connector types whose stored ciphertext is a bearer-style API token that
 * belongs in `config.apiKey`. Other types (e.g. `kubernetes`, where the
 * ciphertext is a kubeconfig YAML) resolve their secret through their own
 * runner and must NOT be hydrated here.
 */
const TOKEN_AUTH_TYPES = new Set(['prometheus', 'victoria-metrics', 'loki', 'humio']);

/**
 * Resolve `connector_secrets` ciphertext into `config.apiKey` for connectors
 * that don't already carry an inline credential. Returns new Connector objects
 * (original `connector.config` is not mutated). Connectors with no stored
 * secret pass through unchanged.
 *
 * Decrypted tokens MUST NOT be forwarded into LLM prompts or audit payloads.
 * The orchestrator's `toAgentConnectors` strips credential fields — keep that
 * boundary intact when adding new call sites.
 */
export async function hydrateConnectorSecrets(
  connectors: Connector[],
  secretReader: ConnectorSecretReader,
): Promise<Connector[]> {
  return Promise.all(
    connectors.map(async (connector) => {
      if (!TOKEN_AUTH_TYPES.has(connector.type)) return connector;
      if (inlineApiKey(connector)) return connector;

      const row = await secretReader.getSecret(connector.id);
      if (!row?.ciphertext || row.ciphertext.length === 0) return connector;

      const token = Buffer.from(row.ciphertext).toString('utf8').trim();
      if (!token) return connector;

      return {
        ...connector,
        config: {
          ...connector.config,
          apiKey: token,
        },
      };
    }),
  );
}
