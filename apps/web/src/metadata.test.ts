// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestRoot } from './testing/react-root.js';
import { usePageMetadata } from './metadata.js';
import type { PageMetadata } from './metadata.js';

function TestComponent({ metadata }: { metadata: PageMetadata }) {
  usePageMetadata(metadata);
  return createElement('div', null, 'Test content');
}

describe('usePageMetadata', () => {
  const initialTitle = 'Initial Title';

  beforeEach(() => {
    document.head.innerHTML = '<title>Initial Title</title>';
  });

  afterEach(() => {
    document.head.innerHTML = '<title>Initial Title</title>';
  });

  it('sets document title with site suffix, description, canonical, and social meta tags', async () => {
    const view = createTestRoot();

    await act(async () => {
      view.root.render(
        createElement(TestComponent, {
          metadata: {
            title: 'Plans & Pricing',
            description: 'Clear pricing for monitoring.',
            canonical: '/pricing',
          },
        }),
      );
      await Promise.resolve();
    });

    expect(document.title).toBe('Plans & Pricing — Uptime');
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Clear pricing for monitoring.',
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://uptime.noz.am/pricing',
    );
    expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
      'Plans & Pricing — Uptime',
    );
    expect(document.head.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(
      'Clear pricing for monitoring.',
    );
    expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(
      'https://uptime.noz.am/pricing',
    );
    expect(document.head.querySelector('meta[property="og:site_name"]')?.getAttribute('content')).toBe(
      'Uptime',
    );
    expect(document.head.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe(
      'summary',
    );
    expect(document.head.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(
      'Plans & Pricing — Uptime',
    );

    await view.cleanup();

    expect(document.title).toBe(initialTitle);
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.head.querySelector('meta[name="description"]')).toBeNull();
  });

  it('avoids duplicating site name if already present in title', async () => {
    const view = createTestRoot();

    await act(async () => {
      view.root.render(
        createElement(TestComponent, {
          metadata: {
            title: 'Uptime — Custom Title',
          },
        }),
      );
      await Promise.resolve();
    });

    expect(document.title).toBe('Uptime — Custom Title');
    await view.cleanup();
  });

  it('uses default title and custom image/ogType when specified', async () => {
    const view = createTestRoot();

    await act(async () => {
      view.root.render(
        createElement(TestComponent, {
          metadata: {
            ogType: 'article',
            ogImage: 'https://uptime.noz.am/custom.png',
          },
        }),
      );
      await Promise.resolve();
    });

    expect(document.title).toBe('Uptime — Simple multi-region uptime monitoring');
    expect(document.head.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('article');
    expect(document.head.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(
      'https://uptime.noz.am/custom.png',
    );
    await view.cleanup();
  });
});
