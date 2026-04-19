/**
 * AES-256-GCM encryption helper for at-rest secrets (OAuth tokens, SAML
 * private keys read from DB, etc.).
 *
 * Wire format: `<iv_hex>:<ciphertext_hex>:<tag_hex>` — all three components
 * are hex-encoded and delimited by colons. The IV is 12 bytes (GCM standard);
 * the auth tag is 16 bytes.
 *
 * Key derivation: the caller-supplied `secret` is hashed with SHA-256 to
 * produce a fixed 32-byte key. Callers should pass a long, random
 * `SECRET_KEY` env var; rotation is out of scope for this helper.
 *
 * See docs/auth-perm-design/01-database-schema.md §user_auth (tokens are
 * encrypted via this helper).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MIN_SECRET_LEN = 32;

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encrypt(plaintext: string, secret: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt: plaintext must be a string');
  }
  if (!secret || typeof secret !== 'string') {
    throw new TypeError('encrypt: secret must be a non-empty string');
  }
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

export function decrypt(encoded: string, secret: string): string {
  if (typeof encoded !== 'string') {
    throw new TypeError('decrypt: encoded must be a string');
  }
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('decrypt: malformed ciphertext (expected iv:ct:tag)');
  }
  const iv = Buffer.from(parts[0]!, 'hex');
  const ct = Buffer.from(parts[1]!, 'hex');
  const tag = Buffer.from(parts[2]!, 'hex');
  if (iv.length !== IV_BYTES) {
    throw new Error(`decrypt: invalid iv length (${iv.length})`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`decrypt: invalid auth tag length (${tag.length})`);
  }
  const key = deriveKey(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Returns SECRET_KEY from env. Throws loudly (in every environment) if the
 * value is missing or shorter than 32 chars.
 *
 * The api-gateway's `auth/bootstrap-secrets.ts` runs on first boot and
 * auto-generates SECRET_KEY + JWT_SECRET, persisting them to
 * `<DATA_DIR>/secrets.json` (0600) and hydrating `process.env`. Operators
 * should never need to touch that file — it's automatic. If you're seeing
 * this error, bootstrap was skipped (custom entry point, test harness
 * without setup, misconfigured container) or `SECRET_KEY` was set to
 * an empty / too-short value. Fix: set `SECRET_KEY` to a ≥32-char random
 * string, or let bootstrap-secrets run by using the standard gateway entry
 * (`packages/api-gateway/src/main.ts`).
 */
export function resolveSecretKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['SECRET_KEY'];
  if (!fromEnv || fromEnv.length === 0) {
    throw new Error(
      'SECRET_KEY env var is required (used for AES-256-GCM encryption of OAuth tokens and other at-rest secrets). ' +
        'The api-gateway bootstraps this automatically via packages/api-gateway/src/auth/bootstrap-secrets.ts on first boot; ' +
        'if you see this error, bootstrap did not run (custom entry point or test harness) — set SECRET_KEY to a ≥32-char random string.',
    );
  }
  if (fromEnv.length < MIN_SECRET_LEN) {
    throw new Error(
      `SECRET_KEY is too short (${fromEnv.length} chars; minimum ${MIN_SECRET_LEN}). ` +
        'Use a ≥32-char random string (e.g. `openssl rand -hex 32`), or delete the value and let ' +
        'packages/api-gateway/src/auth/bootstrap-secrets.ts regenerate it on next boot.',
    );
  }
  return fromEnv;
}

/** Key length the AES-256-GCM primitive requires. Exposed for tests. */
export const AES_KEY_LEN = KEY_BYTES;
export const AES_IV_LEN = IV_BYTES;
export const AES_TAG_LEN = TAG_BYTES;
