import {
  defaultStatusPageFontFamily,
  statusPageFontFamilies,
  type StatusPageFontFamily,
} from '@uptime/contracts';

export type FontFamily = StatusPageFontFamily;
export const defaultFontFamily = defaultStatusPageFontFamily;
export const fontPreferenceKey = 'uptime.fontFamily';

const labels: Record<FontFamily, string> = {
  'josefin-sans': 'Josefin Sans',
  rubik: 'Rubik',
  roboto: 'Roboto',
  'open-sans': 'Open Sans',
  inter: 'Inter',
  'dm-sans': 'DM Sans',
  poppins: 'Poppins',
  nunito: 'Nunito',
  ubuntu: 'Ubuntu',
  helvetica: 'Helvetica',
};

export const fontOptions = statusPageFontFamilies.map((value) => ({ value, label: labels[value] }));

export function resolveFontFamily(value: unknown): FontFamily {
  return typeof value === 'string' && statusPageFontFamilies.includes(value as FontFamily)
    ? value as FontFamily
    : defaultFontFamily;
}

export function readFontPreference(): FontFamily {
  try {
    return resolveFontFamily(window.localStorage.getItem(fontPreferenceKey));
  } catch {
    return defaultFontFamily;
  }
}

export function saveFontPreference(value: FontFamily): void {
  document.documentElement.dataset.font = value;
  try {
    window.localStorage.setItem(fontPreferenceKey, value);
  } catch {
    // Browsers can disable local storage; keep the choice for this page.
  }
}
