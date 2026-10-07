// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultFontFamily,
  readFontPreference,
  resolveFontFamily,
  saveFontPreference,
} from './font-choice.js';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.font;
});

describe('font preference', () => {
  it('defaults missing and unsupported values to Josefin Sans', () => {
    expect(readFontPreference()).toBe(defaultFontFamily);
    expect(resolveFontFamily('unsupported')).toBe('josefin-sans');
    localStorage.setItem('uptime.fontFamily', 'unsupported');
    expect(readFontPreference()).toBe('josefin-sans');
  });

  it('persists and applies the selected admin font', () => {
    saveFontPreference('rubik');
    expect(readFontPreference()).toBe('rubik');
    expect(document.documentElement.dataset.font).toBe('rubik');
  });
});
