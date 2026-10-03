import { useRouter } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

/** Preserve browser link behavior while keeping in-app navigation in the current session. */
export function AppLink({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const router = useRouter({ warn: false });
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      !router ||
      !href?.startsWith('/') ||
      href.startsWith('//') ||
      props.target ||
      props.download ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    void router.navigate({ href });
  }
  return <a {...props} href={href} onClick={navigate} />;
}
