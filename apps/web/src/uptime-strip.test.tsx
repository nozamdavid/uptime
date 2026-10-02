// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UptimeStrip } from './uptime-strip.js';

describe('uptime strip severity', () => {
  it('uses the default four uptime color bands', () => {
    const markup = renderToStaticMarkup(
      createElement(UptimeStrip, {
        label: 'Daily uptime',
        days: [
          { date: '2026-08-28', uptimePercentage: 100, averageResponseMs: 100 },
          { date: '2026-08-29', uptimePercentage: 99.6, averageResponseMs: 110 },
          { date: '2026-08-30', uptimePercentage: 99.2, averageResponseMs: 120 },
          { date: '2026-08-31', uptimePercentage: 95, averageResponseMs: 120 },
          { date: '2026-09-01', uptimePercentage: 89.9, averageResponseMs: 120 },
        ],
      }),
    );

    expect(markup).toContain('uptime-day--green');
    expect(markup).toContain('uptime-day--light-green');
    expect(markup).toContain('uptime-day--orange');
    expect(markup).toContain('uptime-day--red');
  });
});
