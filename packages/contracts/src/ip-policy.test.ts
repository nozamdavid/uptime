import { describe, expect, it } from 'vitest';

import {
  isForbiddenIpLiteral,
  isForbiddenIpv4Literal,
  isForbiddenIpv6Literal,
} from './ip-policy.js';

describe('shared IP-literal policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.51.100.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '64:ff9b::a00:1',
    '64:ff9b:1:abcd::1',
    '2002:a00:1::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '::a00:1',
    '100::1234',
    '0064:ff9b:0000:0000:0000:0000:0a00:0001',
    '0000:0000:0000:0000:0000:0000:0a00:0001',
  ])('blocks forbidden literal %s', (address) => {
    expect(isForbiddenIpLiteral(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '203.1.1.1', '2606:4700:4700::1111', '64:ff9b:2::1'])(
    'allows public literal %s',
    (address) => {
      expect(isForbiddenIpLiteral(address)).toBe(false);
    },
  );

  it('ignores brackets, case, and hostnames', () => {
    expect(isForbiddenIpLiteral('[::1]')).toBe(true);
    expect(isForbiddenIpv6Literal('FE80::1')).toBe(true);
    expect(isForbiddenIpv4Literal('example.com')).toBe(false);
    expect(isForbiddenIpLiteral('example.com')).toBe(false);
  });
});
