import { describe, expect, it } from 'vitest';

import { workersOAuthRuntime } from './atproto-auth.js';

describe('workersOAuthRuntime.createKey', () => {
  it('generates an exportable ES256 DPoP key with real WebCrypto', async () => {
    const key = await workersOAuthRuntime.createKey(['ES256']);

    expect(key.algorithms).toEqual(['ES256']);
    expect(key.privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(key.privateJwk).toHaveProperty('d', expect.any(String));

    const jwt = await key.createJwt({ alg: 'ES256' }, { sub: 'dpop' });
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('picks the first supported algorithm', async () => {
    const key = await workersOAuthRuntime.createKey(['EdDSA', 'ES384']);

    expect(key.privateJwk).toMatchObject({ crv: 'P-384', alg: 'ES384' });
  });
});
