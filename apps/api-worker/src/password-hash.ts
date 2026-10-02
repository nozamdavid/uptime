import { base64UrlDecode } from '@uptime/cloudflare';

const passwordHashAlgorithm = 'pbkdf2-sha256';
const passwordHashMaxIterations = 100_000;
const passwordSaltBytes = 16;
const passwordKeyBytes = 32;
const base64UrlPart = /^[A-Za-z0-9_-]+$/;

/** Validate the complete PBKDF2 envelope before asking workerd to derive a key. */
export function isSupportedPasswordHash(hash: string): boolean {
  const parts = hash.split('$');
  if (parts.length !== 4 || parts[0] !== passwordHashAlgorithm) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > passwordHashMaxIterations) {
    return false;
  }
  const salt = parts[2]!;
  const expected = parts[3]!;
  if (!base64UrlPart.test(salt) || !base64UrlPart.test(expected)) return false;
  try {
    return (
      base64UrlDecode(salt).byteLength === passwordSaltBytes &&
      base64UrlDecode(expected).byteLength === passwordKeyBytes
    );
  } catch {
    return false;
  }
}
