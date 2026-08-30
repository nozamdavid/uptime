import argon2 from 'argon2';

const canonicalArgon2idPhc =
  /^\$argon2id\$v=19\$m=[1-9]\d*,t=[1-9]\d*,p=[1-9]\d*\$[A-Za-z0-9+/.-]+\$[A-Za-z0-9+/.-]+$/;
const validationPassword = 'uptime-password-hash-validation';

export class InvalidAdminPasswordHashError extends Error {
  constructor() {
    super('ADMIN_PASSWORD_HASH must be a parseable, canonical Argon2id PHC string');
    this.name = 'InvalidAdminPasswordHashError';
  }
}

/**
 * Validates the exact PHC parser used by argon2. A `false` verification result
 * means the hash was parsed successfully and simply does not match this fixed
 * validation password.
 */
export async function assertValidAdminPasswordHash(hash: string): Promise<void> {
  if (!canonicalArgon2idPhc.test(hash)) throw new InvalidAdminPasswordHashError();
  try {
    await argon2.verify(hash, validationPassword);
  } catch {
    throw new InvalidAdminPasswordHashError();
  }
}

export async function verifyAdminPassword(
  hash: string,
  password: string,
): Promise<{ hashIsValid: true; matches: boolean } | { hashIsValid: false; matches: false }> {
  if (!canonicalArgon2idPhc.test(hash)) return { hashIsValid: false, matches: false };
  try {
    return { hashIsValid: true, matches: await argon2.verify(hash, password) };
  } catch {
    return { hashIsValid: false, matches: false };
  }
}
