import type {
  NotificationHistoryEntry,
  NotificationHistoryResponse,
  NotificationService,
} from '@uptime/contracts';
import { useEffect, useRef, useState } from 'react';

import { api, RequestError } from './api.js';

function externalHref(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function formattedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return { local: value, absolute: value };
  const pad = (n: number) => String(n).padStart(2, '0');
  const formatted = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  return {
    local: formatted,
    absolute: date.toISOString(),
  };
}

function titleForKind(kind: NotificationHistoryEntry['kind']) {
  switch (kind) {
    case 'outage':
      return 'Outage';
    case 'recovery':
      return 'Recovery';
    case 'reminder':
      return 'Reminder';
    case 'test':
      return 'Test';
  }
}

export function NotificationHistoryView({
  service,
  onBack,
  services = [],
  refreshKey = 0,
}: {
  service?: NotificationService;
  onBack?: () => void;
  services?: NotificationService[];
  refreshKey?: number;
}) {
  const [entries, setEntries] = useState<NotificationHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  const serviceId = service?.id;

  useEffect(() => {
    let current = true;
    const version = ++requestVersion.current;
    setEntries([]);
    setNextCursor(null);
    setLoading(true);
    setLoadingMore(false);
    setError('');
    setLoadFailed(false);
    const request = serviceId
      ? api.notificationHistory(serviceId)
      : api.globalNotificationHistory();
    request
      .then((page: NotificationHistoryResponse) => {
        if (!current) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => {
        if (current) {
          setError(messageFor(reason));
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, [serviceId, reload, refreshKey]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const cursor = nextCursor;
    const version = requestVersion.current;
    setLoadingMore(true);
    setError('');
    try {
      const page = await (serviceId
        ? api.notificationHistory(serviceId, cursor)
        : api.globalNotificationHistory(cursor));
      if (version !== requestVersion.current) return;
      setEntries((current) => {
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...page.entries.filter((entry) => !seen.has(entry.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (version === requestVersion.current) setError(messageFor(reason));
    } finally {
      if (version === requestVersion.current) setLoadingMore(false);
    }
  }

  return (
    <section
      className={`notification-history${service ? '' : ' notification-history--global'}`}
      aria-labelledby="notification-history-title"
    >
      <header className="notification-history__head">
        <div>
          {service ? (
            <>
              <button className="button button--quiet" onClick={onBack}>
                ← Back to services
              </button>
              <span className="mono-label">{service.provider}</span>
              <h1 id="notification-history-title">{service.name} history</h1>
              <p>Messages sent or attempted through this notification service.</p>
            </>
          ) : (
            <>
              <h2 id="notification-history-title">Notification history</h2>
              <p>Recent messages across all configured notification services.</p>
            </>
          )}
        </div>
        {!service && (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setReload((value) => value + 1)}
            disabled={loading || loadingMore}
          >
            Refresh history
          </button>
        )}
      </header>

      {error && !loading && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="state state--loading" role="status">
          <p>Loading notification history…</p>
        </div>
      ) : loadFailed && entries.length === 0 ? (
        <div className="state state--error">
          <p>{error || 'Notification history could not be loaded.'}</p>
          <button
            className="button button--quiet"
            onClick={() => {
              setReload((current) => current + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="state state--empty">
          <p>No notification history yet.</p>
        </div>
      ) : (
        services && (
          <>
            <ol className="notification-history__list">
              {entries.map((item) => (
                <li key={item.id} className="notification-history__item">
                  {service ? (
                    <CompactHistoryEntry entry={item} serviceName={undefined} />
                  ) : (
                    <CompactHistoryEntry
                      entry={item}
                      serviceName={
                        services.find((match) => match.id === item.notificationServiceId)?.name
                      }
                    />
                  )}
                </li>
              ))}
            </ol>
            {nextCursor && (
              <div className="notification-history__more">
                <button
                  className="button button--quiet"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}

function CompactHistoryEntry({
  entry,
  serviceName,
}: {
  entry: NotificationHistoryEntry;
  serviceName: string | undefined;
}) {
  const date = formattedDate(entry.createdAt);
  const delivered = entry.status === 'sent';
  return (
    <details className="notification-history__row">
      <summary>
        <span className="notification-history__chevron" aria-hidden="true">
          ›
        </span>
        <span
          className={`ut-status ut-status--${delivered ? 'up' : 'down'} notification-history__status notification-history__status--${entry.status}`}
        >
          <span className={`ut-glyph ut-glyph--${delivered ? 'up' : 'down'}`} aria-hidden="true" />
          {delivered ? 'Sent' : 'Failed'}
        </span>
        <span className="notification-history__row-kind">{titleForKind(entry.kind)}</span>
        <span className="notification-history__destination">
          <span className="mono-label">{entry.provider}</span>
          {serviceName && <span title={serviceName}>{serviceName}</span>}
        </span>
        <span className="notification-history__row-monitor" title={entry.monitorName}>
          {entry.monitorName}
        </span>
        <time dateTime={entry.createdAt} title={date.absolute}>
          {date.local}
        </time>
      </summary>
      <HistoryEntryView entry={entry} />
    </details>
  );
}

function HistoryEntryView({ entry }: { entry: NotificationHistoryEntry }) {
  const date = formattedDate(entry.createdAt);
  const external = externalHref(entry.externalUrl);
  const monitorUrl = externalHref(entry.monitorUrl);
  const delivered = entry.status === 'sent';
  return (
    <article className="notification-history__entry">
      <header className="notification-history__entry-head">
        <div className="notification-history__event">
          <span
            className={`ut-status ut-status--${delivered ? 'up' : 'down'} notification-history__status notification-history__status--${entry.status}`}
          >
            <span className={`ut-glyph ut-glyph--${delivered ? 'up' : 'down'}`} aria-hidden="true" />
            {delivered ? 'Sent' : 'Failed'}
          </span>
          <span className="notification-history__kind">{titleForKind(entry.kind)}</span>
          <time dateTime={entry.createdAt} title={date.absolute}>
            {date.local}
          </time>
        </div>
        {external && (
          <a
            href={external}
            target="_blank"
            rel="noreferrer"
            className="notification-history__external"
          >
            {entry.provider === 'bluesky' ? 'View post ↗' : 'Open message ↗'}
          </a>
        )}
      </header>

      <p className="notification-history__monitor">
        {entry.kind !== 'test' && entry.monitorId ? (
          <a href={`/monitors/${encodeURIComponent(entry.monitorId)}`}>{entry.monitorName}</a>
        ) : entry.kind !== 'test' && monitorUrl ? (
          <a href={monitorUrl} target="_blank" rel="noreferrer">
            {entry.monitorName}
          </a>
        ) : (
          <span>{entry.monitorName}</span>
        )}
      </p>

      {entry.status === 'failed' && entry.error && (
        <p className="notification-history__error">{entry.error}</p>
      )}

      <NotificationPreview entry={entry} />
    </article>
  );
}

function NotificationPreview({ entry }: { entry: NotificationHistoryEntry }) {
  const email = entry.provider === 'resend' || entry.provider === 'smtp';
  const previewLabel = entry.status === 'sent' ? 'Message preview' : 'Attempted message';
  return (
    <section
      className={`notification-preview notification-preview--${entry.provider}`}
      aria-label={previewLabel}
    >
      <div className="notification-preview__label">{previewLabel}</div>
      {email ? (
        <div className="notification-preview__email">
          <div className="notification-preview__email-head">
            <span className="notification-preview__email-mark" aria-hidden="true">
              ✉
            </span>
            <div>
              <strong>{entry.preview.subject?.trim() || 'Monitor notification'}</strong>
              {entry.preview.from && <span>From {entry.preview.from}</span>}
              {entry.preview.to?.length ? <span>To {entry.preview.to.join(', ')}</span> : null}
            </div>
          </div>
          <MessageText text={entry.text} />
        </div>
      ) : entry.provider === 'telegram' ? (
        <div className="notification-preview__telegram-wrap">
          <div className="notification-preview__telegram">
            <span className="notification-preview__sender">
              {entry.preview.from || 'Notification'}
            </span>
            <MessageText text={entry.text} />
          </div>
        </div>
      ) : entry.provider === 'bluesky' ? (
        <div className="notification-preview__bsky">
          <span className="notification-preview__bsky-handle">
            {entry.preview.handle ? `@${entry.preview.handle.replace(/^@/, '')}` : 'Bluesky post'}
          </span>
          <MessageText text={entry.text} />
        </div>
      ) : (
        <div
          className={`notification-preview__message notification-preview__message--${entry.provider}`}
        >
          {entry.provider === 'discord' && (
            <span className="notification-preview__sender">Webhook message</span>
          )}
          {entry.provider === 'gotify' && (
            <span className="notification-preview__sender">Gotify notification</span>
          )}
          {entry.provider === 'home-assistant' && (
            <span className="notification-preview__sender">Home Assistant</span>
          )}
          <MessageText text={entry.text} />
        </div>
      )}
    </section>
  );
}

function MessageText({ text }: { text: string }) {
  return <p className="notification-preview__text">{text}</p>;
}

function messageFor(reason: unknown) {
  return reason instanceof RequestError || reason instanceof Error
    ? reason.message
    : 'Notification history could not be loaded.';
}
