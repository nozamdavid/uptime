import type { ReactNode } from 'react';
import { SiteFooter } from './site-footer.js';

const EMAIL = 'davidmarcosg98@gmail.com';
const UPDATED = '20 October 2026';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="landing legal-page">
      <header className="landing__nav landing__nav--centered">
        <a className="brand" href="/">
          Uptime
        </a>
      </header>

      <article className="legal-page__body">
        <p className="mono-label">LEGAL</p>
        <h1>{title}</h1>
        <p className="landing__note">Last updated: {UPDATED}</p>
        {children}
      </article>

      <SiteFooter />
    </main>
  );
}

export function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <section>
        <h2>Who provides the service</h2>
        <p>
          Uptime is operated by David Marcos, an individual based in Spain. See the{' '}
          <a href="/contact">contact page</a> for details.
        </p>
      </section>

      <section>
        <h2>Access</h2>
        <p>
          The service is invite-only and currently free. Access may be limited, changed or
          withdrawn at any time. If paid plans are introduced, they will be announced before they
          apply to your workspace.
        </p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>
          Only add URLs you own or are allowed to monitor. Do not use the service to attack,
          overload or scan third-party systems, to send abusive traffic, or to publish unlawful
          content on status pages. Probe requests come from Cloudflare Workers in several regions
          at the intervals you configure.
        </p>
      </section>

      <section>
        <h2>Your content</h2>
        <p>
          You keep ownership of the monitors, notification settings and status page content you
          enter. You allow the service to store and process them to run monitoring and publish the
          status pages you create.
        </p>
      </section>

      <section>
        <h2>Availability and liability</h2>
        <p>
          The service is provided as is, without a guarantee of availability, accuracy or fitness
          for a particular purpose. Do not rely on it as your only alert for critical systems.
          Within the limits of applicable law, the operator is not liable for indirect or
          consequential loss. Nothing in these terms limits rights you have as a consumer under
          mandatory law.
        </p>
      </section>

      <section>
        <h2>Termination</h2>
        <p>
          You can delete your workspace at any time or ask for deletion by email. Access may be
          suspended for breach of these terms or abuse of the service.
        </p>
      </section>

      <section>
        <h2>Changes and governing law</h2>
        <p>
          These terms may be updated; the date above shows the latest version. They are governed
          by the laws of Spain. Questions: <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
        </p>
      </section>
    </LegalPage>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <section>
        <h2>Controller</h2>
        <p>
          David Marcos, an individual based in Spain, is the data controller. Contact:{' '}
          <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
        </p>
      </section>

      <section>
        <h2>What we collect</h2>
        <ul>
          <li>
            Sign-in is through Bluesky (AT Protocol OAuth). We store your AT Protocol handle and
            DID.
          </li>
          <li>
            A session cookie keeps you signed in. It expires after 7 days. We do not use tracking
            cookies.
          </li>
          <li>Monitor URLs, notification settings and status page content that you enter.</li>
          <li>Check results produced by monitoring the URLs you add.</li>
        </ul>
      </section>

      <section>
        <h2>How we use it</h2>
        <p>
          To sign you in, run checks against your URLs, send the notifications you configure and
          publish the status pages you create. Probe requests are sent to your URLs from
          Cloudflare Workers in several regions. Cloudflare acts as a processor. There are no ads
          and no sale of data.
        </p>
      </section>

      <section>
        <h2>Where it is stored</h2>
        <p>
          The application runs on a virtual private server with a PostgreSQL database. Nightly
          database backups are encrypted and uploaded to Google Drive, where they are deleted
          after 30 days. Local backup copies are deleted after 14 days.
        </p>
      </section>

      <section>
        <h2>Retention</h2>
        <ul>
          <li>Daily uptime summaries: 90 days.</li>
          <li>Raw check results: 24 hours.</li>
          <li>DNS diagnostics: 30 days.</li>
          <li>
            Account data: until you delete your workspace or ask for deletion by email. Backups
            age out on the schedule above.
          </li>
        </ul>
      </section>

      <section>
        <h2>Legal basis</h2>
        <p>
          Processing is needed to provide the service you request (GDPR Article 6(1)(b)) and for
          the legitimate interest of keeping it secure and reliable (Article 6(1)(f)).
        </p>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          Under the EU GDPR you have the right of access, rectification, erasure, restriction,
          portability and objection. Exercise them by email to{' '}
          <a href={`mailto:${EMAIL}`}>{EMAIL}</a>. You can also complain to the Spanish data
          protection authority, the Agencia Española de Protección de Datos (AEPD):{' '}
          <a href="https://www.aepd.es" target="_blank" rel="noopener noreferrer">
            aepd.es
          </a>
          .
        </p>
      </section>
    </LegalPage>
  );
}

export function ContactPage() {
  return (
    <LegalPage title="Contact">
      <section>
        <h2>Operator</h2>
        <p>
          Operator: David Marcos (individual)
          <br />
          Country: Spain
          <br />
          Email: <a href={`mailto:${EMAIL}`}>{EMAIL}</a>
        </p>
      </section>

      <section>
        <h2>Requests</h2>
        <p>
          Write to this address for support, privacy requests such as access or deletion, and
          legal notices. See the <a href="/privacy">privacy policy</a> and{' '}
          <a href="/terms">terms of service</a>.
        </p>
      </section>
    </LegalPage>
  );
}
