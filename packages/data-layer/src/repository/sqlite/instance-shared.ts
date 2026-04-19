/**
 * Shared helpers for the instance-config repositories (W2 / T2.2).
 *
 * Encryption: secret columns are encrypted with the SECRET_KEY env var
 * via `@agentic-obs/common/crypto.encrypt`. The returned ciphertext
 * includes the IV + auth tag so rotation at rest means re-encrypting
 * rows, not rewriting the wire format.
 *
 * Decryption failures are NOT swallowed. If a ciphertext on disk no
 * longer decrypts under the current key (operator rotated SECRET_KEY
 * without re-encrypting), the repository throws so the caller sees a
 * real failure — "silent empty config" would be worse than an explicit
 * 500.
 */

import { randomUUID } from 'node:crypto';
import { encrypt, decrypt, resolveSecretKey } from '@agentic-obs/common/crypto';

export function uid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return Number(v) === 1;
}

export function fromBool(v: boolean | undefined | null, dflt = false): number {
  return (v ?? dflt) ? 1 : 0;
}

/** Encrypt a plaintext secret. Returns null for null/empty input. */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  return encrypt(plain, resolveSecretKey());
}

/**
 * Decrypt a column value. Pass-through for null. Throws if the value is
 * non-null but decryption fails — callers must deal with the error, not
 * silently drop the field.
 */
export function decryptSecret(encoded: string | null | undefined): string | null {
  if (encoded === null || encoded === undefined || encoded === '') return null;
  return decrypt(encoded, resolveSecretKey());
}

/**
 * Replace a secret with a masked placeholder for UI. Matches the
 * convention used in the old routes/setup.ts: bullets + last 4 plaintext
 * characters when the value is long enough, otherwise just bullets.
 */
export function maskSecret(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  if (plain.length <= 4) return '••••••';
  return '••••••' + plain.slice(-4);
}
