import { describe, expect, it } from 'vitest';

import {
  mergeProviderConfig,
  providerConfigKeysAreValid,
  publicProviderConfig,
} from './notification-config.js';

const smtp = {
  host: 'smtp.example.com',
  port: 587,
  security: 'starttls',
  username: 'admin',
  password: ' saved password ',
  from: 'alerts@example.com',
  to: ['ops@example.com'],
  subject: 'Outage',
};
const invalidConfig = (): never => {
  throw new Error('invalid provider keys');
};

describe('shared provider configuration', () => {
  it('retains Bluesky app passwords and exposes only the handle', () => {
    const saved = { handle: 'ops.example.com', appPassword: 'saved-secret' };
    const merged = mergeProviderConfig(
      'bluesky',
      saved,
      { handle: '@New.Custom.Domain', appPassword: '' },
      invalidConfig,
    );
    expect(merged).toEqual({ handle: 'new.custom.domain', appPassword: 'saved-secret' });
    expect(publicProviderConfig('bluesky', merged)).toEqual({ handle: 'new.custom.domain' });
  });

  it('keeps SMTP password whitespace and clears explicitly blank optional fields', () => {
    const merged = mergeProviderConfig(
      'smtp',
      smtp,
      { password: '', username: '  ', subject: '  ' },
      invalidConfig,
    );
    expect(merged.password).toBe(smtp.password);
    expect(merged).not.toHaveProperty('username');
    expect(merged).not.toHaveProperty('subject');
    expect(mergeProviderConfig('smtp', smtp, { password: '  ' }, invalidConfig).password).toBe(
      '  ',
    );
  });

  it('retains absent optional fields but validates explicit null values', () => {
    expect(mergeProviderConfig('smtp', smtp, { port: 465 }, invalidConfig).subject).toBe('Outage');
    expect(() => mergeProviderConfig('smtp', smtp, { subject: null }, invalidConfig)).toThrow();
  });

  it('rejects fields from another provider and inherited object keys', () => {
    expect(providerConfigKeysAreValid('telegram', { apiKey: 'secret' })).toBe(false);
    expect(providerConfigKeysAreValid('telegram', { constructor: 'secret' })).toBe(false);
    expect(() => mergeProviderConfig('smtp', smtp, { apiKey: 'secret' }, invalidConfig)).toThrow(
      'invalid provider keys',
    );
  });
});
