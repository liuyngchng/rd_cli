/**
 * Credential encryption for external service tokens.
 *
 * user_credentials stores GitHub/GitLab tokens etc. at rest in SQLite.
 * This module encrypts credential_value with AES-256-GCM before write and
 * decrypts on read so a stolen database file doesn't expose raw tokens.
 *
 * The encryption key is derived from the JWT secret (which is itself
 * auto-generated per installation and stored in app_config), so no
 * additional secret management is required.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

/**
 * Derives a 32-byte AES-256 key from the raw secret string using SHA-256.
 * The caller must provide the JWT secret (which is stable per installation).
 */
function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext value. Returns a hex-encoded string combining
 * IV + ciphertext + auth tag, safe for storage in a TEXT column.
 *
 * Format: `<iv_hex>:<ciphertext_hex>:<auth_tag_hex>`
 */
export function encryptCredentialValue(plaintext: string, encryptionKey: string): string {
  const key = deriveEncryptionKey(encryptionKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

/**
 * Decrypts a value previously encrypted with `encryptCredentialValue`.
 * Returns the original plaintext or `null` if decryption fails.
 */
export function decryptCredentialValue(encryptedData: string, encryptionKey: string): string | null {
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      return null;
    }

    const [ivHex, ciphertextHex, authTagHex] = parts;
    const key = deriveEncryptionKey(encryptionKey);
    const iv = Buffer.from(ivHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}
