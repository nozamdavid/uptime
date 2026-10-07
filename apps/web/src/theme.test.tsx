// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemePreference, readThemePreference, THEME_STORAGE_KEY, ThemeControl } from './theme.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let systemDark = false;
const listeners = new Set<() => void>();
const stored = new Map<string, string>();

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  },
});

beforeEach(() => {
  systemDark = false;
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: systemDark,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }));
});

afterEach(() => {
  listeners.clear();
  document.body.innerHTML = '';
});

describe('theme preference', () => {
  it('restores saved overrides after reload and lets light override a dark system', () => {
    systemDark = true;
    expect(readThemePreference()).toBe('system');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(readThemePreference()).toBe('light');
    applyThemePreference(readThemePreference());
    expect(document.documentElement.dataset.theme).toBe('light');

    systemDark = false;
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    applyThemePreference(readThemePreference());
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('starts from the system theme, follows system changes, then persists each toggle', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(ThemeControl)));

    const button = () => container.querySelector<HTMLButtonElement>('button')!;

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(button().getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(button().title).toBe('Switch to dark theme');
    expect(button().querySelector('svg')).not.toBeNull();
    expect(container.querySelector('select')).toBeNull();
    systemDark = true;
    await act(async () => listeners.forEach((listener) => listener()));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(button().getAttribute('aria-label')).toBe('Switch to light theme');

    button().focus();
    expect(document.activeElement).toBe(button());
    await act(async () => button().click());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(button().getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(listeners.size).toBe(0);

    await act(async () => button().click());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    systemDark = false;
    await act(async () => listeners.forEach((listener) => listener()));
    expect(document.documentElement.dataset.theme).toBe('dark');

    await act(async () => root.unmount());
  });

  it('restores a saved choice in the icon button after remount', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(ThemeControl)));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Switch to light theme');

    await act(async () => root.unmount());
  });
});
