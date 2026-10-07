import { useEffect, useState } from 'react';
import './theme.css';

export type ThemePreference = 'light' | 'dark' | 'system';
type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'uptime.theme';

export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage may be disabled; the system preference still works.
  }
  return 'system';
}

export function applyThemePreference(preference: ThemePreference) {
  const dark = preference === 'dark' ||
    (preference === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function currentTheme(): ThemeMode {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light' || theme === 'dark') return theme;
  const preference = readThemePreference();
  return preference === 'dark' ||
    (preference === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
    ? 'dark' : 'light';
}

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const [theme, setTheme] = useState<ThemeMode>(currentTheme);

  useEffect(() => {
    applyThemePreference(preference);
    setTheme(currentTheme());
    if (preference !== 'system') return;

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const onChange = () => {
      applyThemePreference('system');
      setTheme(currentTheme());
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  useEffect(() => {
    const onThemeChange = (event: Event) => {
      const next = (event as CustomEvent<ThemeMode>).detail;
      setPreference(next);
      setTheme(next);
    };
    window.addEventListener('uptime:theme-change', onThemeChange);
    return () => window.removeEventListener('uptime:theme-change', onThemeChange);
  }, []);

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const action = `Switch to ${nextTheme} theme`;

  return (
    <button
      type="button"
      className="theme-control ut-btn ut-btn--secondary ut-btn--icon"
      aria-label={action}
      title={action}
      onClick={() => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyThemePreference(next);
        setPreference(next);
        setTheme(next);
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // Keep the choice for this page even if storage is unavailable.
        }
        window.dispatchEvent(new CustomEvent<ThemeMode>('uptime:theme-change', { detail: next }));
      }}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v1.5m0 11V15M1 8h1.5m11 0H15M3.05 3.05l1.06 1.06m7.78 7.78 1.06 1.06m0-9.9-1.06 1.06m-7.78 7.78-1.06 1.06" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.8 10.5A6.4 6.4 0 0 1 5.5 2.2a6.4 6.4 0 1 0 8.3 8.3Z" />
        </svg>
      )}
    </button>
  );
}
