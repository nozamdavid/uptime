export function SiteFooter() {
  return (
    <footer className="landing__footer">
      <span>
        Built by{' '}
        <a href="https://bsky.app/profile/noz.am" target="_blank" rel="noopener noreferrer">
          @noz.am
        </a>
      </span>
      <span className="site-footer__version">{__APP_VERSION__}</span>
      <span className="site-footer__links">
        <a href="/operator">Operator</a>
      </span>
    </footer>
  );
}
