import { useEffect } from 'react';

export interface PageMetadata {
  title?: string;
  description?: string;
  canonical?: string;
  ogType?: string;
  ogImage?: string;
}

const DEFAULT_TITLE = 'Uptime — Simple multi-region uptime monitoring';
const DEFAULT_DESCRIPTION =
  'Simple multi-region uptime monitoring with alerts and public status pages.';
const SITE_NAME = 'Uptime';
const SITE_URL = 'https://uptime.noz.am';
const DEFAULT_IMAGE = 'https://uptime.noz.am/favicon.svg';

function setMetaTag(attrName: 'name' | 'property', attrValue: string, content: string): () => void {
  if (typeof document === 'undefined') return () => {};
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attrName}="${attrValue}"]`);
  const prevContent = element ? element.getAttribute('content') : null;
  const created = !element;

  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attrName, attrValue);
    document.head.append(element);
  }
  element.setAttribute('content', content);

  return () => {
    if (created) {
      element?.remove();
    } else if (element && prevContent !== null) {
      element.setAttribute('content', prevContent);
    }
  };
}

function setCanonicalLink(href: string): () => void {
  if (typeof document === 'undefined') return () => {};
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const prevHref = element ? element.getAttribute('href') : null;
  const created = !element;

  if (!element) {
    element = document.createElement('link');
    element.setAttribute('rel', 'canonical');
    document.head.append(element);
  }
  element.setAttribute('href', href);

  return () => {
    if (created) {
      element?.remove();
    } else if (element && prevHref !== null) {
      element.setAttribute('href', prevHref);
    }
  };
}

export function usePageMetadata(metadata: PageMetadata) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prevTitle = document.title;
    const cleanups: Array<() => void> = [];

    const title = metadata.title
      ? metadata.title.includes(SITE_NAME)
        ? metadata.title
        : `${metadata.title} — ${SITE_NAME}`
      : DEFAULT_TITLE;
    document.title = title;

    const description = metadata.description ?? DEFAULT_DESCRIPTION;
    const canonical = metadata.canonical
      ? metadata.canonical.startsWith('http')
        ? metadata.canonical
        : `${SITE_URL}${metadata.canonical}`
      : undefined;
    const image = metadata.ogImage ?? DEFAULT_IMAGE;
    const ogType = metadata.ogType ?? 'website';

    cleanups.push(setMetaTag('name', 'description', description));
    cleanups.push(setMetaTag('property', 'og:site_name', SITE_NAME));
    cleanups.push(setMetaTag('property', 'og:title', title));
    cleanups.push(setMetaTag('property', 'og:description', description));
    cleanups.push(setMetaTag('property', 'og:type', ogType));
    cleanups.push(setMetaTag('property', 'og:image', image));
    cleanups.push(setMetaTag('name', 'twitter:card', 'summary'));
    cleanups.push(setMetaTag('name', 'twitter:title', title));
    cleanups.push(setMetaTag('name', 'twitter:description', description));
    cleanups.push(setMetaTag('name', 'twitter:image', image));

    if (canonical) {
      cleanups.push(setCanonicalLink(canonical));
      cleanups.push(setMetaTag('property', 'og:url', canonical));
      cleanups.push(setMetaTag('name', 'twitter:url', canonical));
    }

    return () => {
      document.title = prevTitle;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    metadata.title,
    metadata.description,
    metadata.canonical,
    metadata.ogType,
    metadata.ogImage,
  ]);
}
