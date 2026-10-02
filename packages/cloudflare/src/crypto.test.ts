import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashPassword,
  hashSessionToken,
  hmacSha256Base64Url,
  nowIso,
  randomId,
  randomToken,
  sha256Hex,
  timingSafeStringEqual,
  verifyPassword,
} from './crypto.js';

describe('crypto helpers', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('generates well-formed UUIDv4 ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('generates url-safe random tokens', () => {
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('hashes deterministically and verifies', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const mac = await hmacSha256Base64Url('secret', 'value');
    expect(mac).toBe(await hashSessionToken('value', 'secret'));
    expect(timingSafeStringEqual(mac, mac)).toBe(true);
    expect(timingSafeStringEqual(mac, 'nope')).toBe(false);
  });

  it('round-trips password hashes and rejects wrong passwords', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('pbkdf2-sha256$100000$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'wrong')).toBe(false);
    expect(await verifyPassword('pbkdf2-sha256$0$aa$bb', 'x')).toBe(false);
    expect(await verifyPassword('pbkdf2-sha256$100001$aa$bb', 'x')).toBe(false);
    expect(await verifyPassword('pbkdf2-sha256$100000$aa$bb', 'x')).toBe(false);
  });

  it('stays within the Workers PBKDF2 iteration cap', async () => {
    const nativeCrypto = globalThis.crypto;
    const deriveBits = vi.fn(async (algorithm: Pbkdf2Params, key: CryptoKey, length: number) => {
      if (algorithm.iterations > 100_000) throw new Error('workerd PBKDF2 limit exceeded');
      return nativeCrypto.subtle.deriveBits(algorithm, key, length);
    });
    vi.stubGlobal('crypto', {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      subtle: {
        importKey: nativeCrypto.subtle.importKey.bind(nativeCrypto.subtle),
        deriveBits,
      },
    });

    const hash = await hashPassword('runtime-compatible password');
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword(hash, 'runtime-compatible password')).toBe(true);
    expect(deriveBits).toHaveBeenCalledTimes(2);
  });

  it('signs and verifies the canonical probe body', async () => {
    const canonical = 'v1\n2026-09-20T00:00:00.000Z\nreq-1\n{"a":1}';
    const signature = await hmacSha256Base64Url('secret', canonical);
    expect(timingSafeStringEqual(signature, await hmacSha256Base64Url('secret', canonical))).toBe(
      true,
    );
    const tampered = canonical.replace('{"a":1}', '{"a":2}');
    expect(timingSafeStringEqual(signature, await hmacSha256Base64Url('secret', tampered))).toBe(
      false,
    );
  });

  it('formats ISO timestamps', () => {
    expect(nowIso(new Date('2026-09-20T18:40:00.000Z'))).toBe('2026-09-20T18:40:00.000Z');
  });
});
