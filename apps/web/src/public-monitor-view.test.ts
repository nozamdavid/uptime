// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const { isPublicMonitorPath } = await import('./main.js');
const { showsPrivateMonitorData } = await import('./monitor-detail.js');

describe('public monitor view', () => {
  it('routes public monitor URLs outside the authenticated shell', () => {
    expect(isPublicMonitorPath('/monitors/public/60127b00-b86d-4e7a-8f43-63edb60b7abf')).toBe(true);
    expect(isPublicMonitorPath('/monitors/60127b00-b86d-4e7a-8f43-63edb60b7abf')).toBe(false);
  });

  it('excludes request history and DNS diagnostics from public views', () => {
    expect(showsPrivateMonitorData(true)).toBe(false);
    expect(showsPrivateMonitorData(false)).toBe(true);
  });
});
