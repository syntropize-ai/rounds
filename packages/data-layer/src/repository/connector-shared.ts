import type {
  ConnectorCategory,
  ConnectorType,
  ConnectorConfig,
  ConnectorPolicyScope,
} from '@agentic-obs/common';
import { CONNECTOR_TEMPLATE_BY_TYPE } from '@agentic-obs/common';
import { encrypt, decrypt, resolveSecretKey } from '@agentic-obs/server-utils/crypto';

/**
 * `connector_secrets.key_version` values.
 *
 * `1` is what every row written before connector secrets were encrypted
 * carries — the `ciphertext` column held the raw kubeconfig / token bytes.
 * `2` marks an AES-256-GCM envelope produced by
 * `@agentic-obs/server-utils/crypto` under SECRET_KEY. The schema appliers
 * re-encrypt any remaining version-1 row on boot, so version 1 must never
 * be written again.
 */
export const CONNECTOR_SECRET_PLAINTEXT_KEY_VERSION = 1;
export const CONNECTOR_SECRET_KEY_VERSION = 2;

/**
 * Wrap raw secret bytes in an AES-256-GCM envelope for storage. Bytes are
 * base64'd first so arbitrary (non-UTF-8) payloads survive the round trip;
 * the stored column holds the helper's `iv:ct:tag` ASCII wire format.
 */
export function sealConnectorSecret(plaintext: Uint8Array): Uint8Array {
  const encoded = encrypt(Buffer.from(plaintext).toString('base64'), resolveSecretKey());
  return Buffer.from(encoded, 'utf8');
}

/**
 * Reverse of `sealConnectorSecret`. Throws on an unknown key version (a row
 * the boot migration should have converted) and lets decryption errors
 * propagate — a connector whose credential cannot be decrypted must fail
 * loudly, never fall back to the stored bytes.
 */
export function openConnectorSecret(stored: Uint8Array, keyVersion: number): Uint8Array {
  if (keyVersion !== CONNECTOR_SECRET_KEY_VERSION) {
    throw new Error(
      `[connector-secrets] unsupported key_version ${keyVersion} (expected ${CONNECTOR_SECRET_KEY_VERSION}); ` +
        'the row was not converted by the boot migration — re-run the gateway against this database',
    );
  }
  const decoded = decrypt(Buffer.from(stored).toString('utf8'), resolveSecretKey());
  return Buffer.from(decoded, 'base64');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function toBool(value: number | boolean): boolean {
  return value === true || value === 1;
}

export function fromBool(value?: boolean): number {
  return value ? 1 : 0;
}

export function parseJson<T>(raw: string | T | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw;
  return JSON.parse(raw) as T;
}

export function stringifyJson(value: ConnectorConfig | ConnectorPolicyScope | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function capabilitiesForType(type: ConnectorType): string[] {
  return [...CONNECTOR_TEMPLATE_BY_TYPE[type].capabilities];
}

export function typeMatchesCategory(type: ConnectorType, category?: ConnectorCategory): boolean {
  if (!category) return true;
  return CONNECTOR_TEMPLATE_BY_TYPE[type].category.includes(category);
}
