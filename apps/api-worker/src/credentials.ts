/**
 * AES-GCM credential encryption for provider configuration stored in D1.
 *
 * The encryption key is derived from `CREDENTIAL_ENCRYPTION_SECRET`, a Worker
 * secret that never reaches the database. Stored values are an opaque envelope
 * `{ "encrypted": "v1.<iv>.<ciphertext>" }` (compact base64url), which is valid
 * JSON so the `json_valid(config)` CHECK still holds. Non-secret projection is
 * performed after decryption by callers.
 *
 * These helpers are exported from `@uptime/api-worker/credentials` so the
 * coordinator Worker can decrypt the same rows without duplicating the format.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const envelopeVersion = 'v1';

export interface EncryptedEnvelope {
  encrypted: string;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret) as BufferSource);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Encrypt an arbitrary JSON-serializable value into a compact token. */
export async function encryptCredentials(secret: string, value: unknown): Promise<string> {
  const key = await deriveKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  return `${envelopeVersion}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

/** Decrypt a token produced by {@link encryptCredentials}. Throws on tampering. */
export async function decryptCredentials(secret: string, token: string): Promise<unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== envelopeVersion) {
    throw new Error('Unsupported credential envelope');
  }
  const key = await deriveKey(secret);
  const iv = fromBase64Url(parts[1]!);
  const ciphertext = fromBase64Url(parts[2]!);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return JSON.parse(textDecoder.decode(plaintext));
}

/** Wrap an encrypted token in the JSON envelope written to `notification_services.config`. */
export async function sealProviderConfig(secret: string, config: unknown): Promise<string> {
  return JSON.stringify({
    encrypted: await encryptCredentials(secret, config),
  } satisfies EncryptedEnvelope);
}

export function isEncryptedConfig(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { encrypted?: unknown }).encrypted === 'string'
  );
}

/**
 * Read a stored `config` value. Encrypted envelopes are decrypted; a plain JSON
 * object is returned as-is so migrated/legacy rows keep working until re-saved.
 */
export async function openProviderConfig(
  secret: string,
  stored: unknown,
): Promise<{ config: Record<string, unknown>; encrypted: boolean }> {
  const decoded = typeof stored === 'string' ? safeJson(stored) : stored;
  if (isEncryptedConfig(decoded)) {
    const value = await decryptCredentials(secret, decoded.encrypted);
    if (typeof value !== 'object' || value === null) {
      throw new Error('Decrypted provider config is not an object');
    }
    return { config: value as Record<string, unknown>, encrypted: true };
  }
  if (typeof decoded === 'object' && decoded !== null) {
    return { config: decoded as Record<string, unknown>, encrypted: false };
  }
  throw new Error('Stored provider config is not an object');
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
