import { describe, expect, it } from 'vitest';

import { assertCurrentlyPublicTarget } from './url-policy.js';

describe('scheduler target revalidation', () => {
  it.each(['http://127.0.0.1', 'http://169.254.169.254', 'http://[::1]'])(
    'rejects forbidden literal %s before probe dispatch',
    async (url) => expect(assertCurrentlyPublicTarget(url)).rejects.toThrow('private or reserved'),
  );

  it('allows a public literal and rejects embedded credentials', async () => {
    await expect(assertCurrentlyPublicTarget('https://1.1.1.1/health')).resolves.toBeUndefined();
    await expect(assertCurrentlyPublicTarget('https://user:pass@example.com')).rejects.toThrow(
      'allowed HTTP(S)',
    );
  });
});
