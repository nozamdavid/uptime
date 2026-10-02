import type {
  NotificationProviderKind,
  NotificationService,
  NotificationServiceCreate,
  NotificationServiceUpdate,
} from '@uptime/contracts';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { api, RequestError } from './api.js';
import { NotificationHistoryView } from './notification-history.js';

interface EditorState {
  id?: string;
  name: string;
  provider: NotificationProviderKind;
  enabled: boolean;
  botToken: string;
  chatId: string;
  webhookUrl: string;
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  serverUrl: string;
  applicationToken: string;
  priority: string;
  bearerToken: string;
  host: string;
  port: string;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  password: string;
  accessToken: string;
  handle?: string;
  appPassword?: string;
  service: string;
}

const emptyEditor: EditorState = {
  name: '',
  provider: 'telegram',
  enabled: true,
  botToken: '',
  chatId: '',
  webhookUrl: '',
  apiKey: '',
  from: '',
  to: '',
  subject: '',
  serverUrl: '',
  applicationToken: '',
  priority: '8',
  bearerToken: '',
  host: '',
  port: '587',
  security: 'starttls',
  username: '',
  password: '',
  accessToken: '',
  handle: '',
  appPassword: '',
  service: 'notify',
};

const providerLabels: Record<NotificationProviderKind, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  resend: 'Resend',
  gotify: 'Gotify',
  webhook: 'Webhook',
  smtp: 'SMTP',
  'home-assistant': 'Home Assistant',
  bluesky: 'Bluesky',
};

function recipients(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readableConfig(service: NotificationService, key: string, fallback = '') {
  const value = service.config[key as keyof NotificationService['config']];
  return value === undefined ? fallback : String(value);
}

function readableRecipients(service: NotificationService) {
  return service.config.to?.join(', ') ?? '';
}

function editorFromService(service: NotificationService): EditorState {
  return {
    ...emptyEditor,
    id: service.id,
    name: service.name,
    provider: service.provider,
    enabled: service.enabled,
    chatId: readableConfig(service, 'chatId'),
    from: readableConfig(service, 'from'),
    to: readableRecipients(service),
    subject: readableConfig(service, 'subject'),
    serverUrl: readableConfig(service, 'serverUrl'),
    priority: String(readableConfig(service, 'priority', '8')),
    host: readableConfig(service, 'host'),
    port: readableConfig(service, 'port', '587'),
    security: readableConfig(service, 'security', 'starttls') as EditorState['security'],
    username: readableConfig(service, 'username'),
    handle: readableConfig(service, 'handle'),
    service: readableConfig(service, 'service', 'notify'),
  };
}

export function NotificationsPage() {
  const [services, setServices] = useState<NotificationService[] | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [historyService, setHistoryService] = useState<NotificationService | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError('');
    api
      .notificationServices()
      .then(({ services: loaded }) => alive && setServices(loaded))
      .catch((reason) => {
        if (!alive) return;
        setServices([]);
        setError(messageFor(reason, 'Notification services could not be loaded.'));
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  async function run(id: string, action: () => Promise<unknown>, success: string) {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(messageFor(reason, 'The notification service could not be updated.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="notifications-page">
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p>Send outage, recovery, and optional reminder messages to your team.</p>
        </div>
        {!editor && !historyService && (
          <button className="button button--primary" onClick={() => setEditor(emptyEditor)}>
            Add service
          </button>
        )}
      </div>

      {error && (
        <p className="field-error notification-feedback" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notification-feedback" role="status">
          {notice}
        </p>
      )}

      {historyService ? (
        <NotificationHistoryView
          key={historyService.id}
          service={historyService}
          onBack={() => setHistoryService(null)}
        />
      ) : editor ? (
        <NotificationServiceEditor
          value={editor}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setNotice('Notification service saved.');
            setReload((value) => value + 1);
          }}
        />
      ) : services === null ? (
        <div className="state state--loading" role="status">
          <p>Loading notification services…</p>
        </div>
      ) : services.length === 0 && !error ? (
        <div className="state state--empty" role="status">
          <p>No notification services yet.</p>
          <button className="button button--quiet" onClick={() => setEditor(emptyEditor)}>
            Add service
          </button>
        </div>
      ) : (
        <div className="notification-list">
          {services.map((service) => (
            <article className="notification-card" key={service.id}>
              <div>
                <span className="mono-label">{service.provider}</span>
                <h2>{service.name}</h2>
                <p>
                  {service.provider === 'telegram' && service.config.chatId
                    ? `Chat ${service.config.chatId}`
                    : service.provider === 'bluesky' && service.config.handle
                      ? `@${service.config.handle} · Bluesky`
                      : service.provider === 'discord'
                        ? 'Discord webhook configured'
                        : 'Configuration saved'}
                </p>
              </div>
              <div className="notification-card__actions">
                <label className="notification-enabled">
                  <input
                    type="checkbox"
                    checked={service.enabled}
                    disabled={busyId === service.id}
                    onChange={(event) =>
                      void run(
                        service.id,
                        () =>
                          api.updateNotificationService(service.id, {
                            enabled: event.target.checked,
                          }),
                        event.target.checked
                          ? 'Notification service enabled.'
                          : 'Notification service disabled.',
                      )
                    }
                  />
                  Enabled
                </label>
                <button
                  className="button button--quiet"
                  disabled={busyId === service.id}
                  onClick={() => setHistoryService(service)}
                >
                  History
                </button>
                <button
                  className="button button--quiet"
                  disabled={busyId === service.id}
                  onClick={() =>
                    void run(
                      service.id,
                      () => api.testNotificationService(service.id),
                      'Test notification sent.',
                    )
                  }
                >
                  Test
                </button>
                <button
                  className="button button--quiet"
                  disabled={busyId === service.id}
                  onClick={() => setEditor(editorFromService(service))}
                >
                  Edit
                </button>
                <button
                  className="button button--danger"
                  disabled={busyId === service.id}
                  onClick={() => {
                    if (!window.confirm(`Delete “${service.name}”? Monitors will stop using it.`))
                      return;
                    void run(
                      service.id,
                      () => api.deleteNotificationService(service.id),
                      'Notification service deleted.',
                    );
                  }}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {!editor && !historyService && services !== null && (
        <NotificationHistoryView services={services} refreshKey={reload} />
      )}
    </section>
  );
}

function NotificationServiceEditor({
  value: initialValue,
  onCancel,
  onSaved,
}: {
  value: EditorState;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const editing = Boolean(value.id);
  const set = <K extends keyof EditorState>(key: K, next: EditorState[K]) =>
    setValue((current) => ({ ...current, [key]: next }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const config: Record<string, unknown> = buildNotificationConfig(value);
      if (value.id) {
        const input: NotificationServiceUpdate = {
          name: value.name,
          enabled: value.enabled,
          config: config as NotificationServiceUpdate['config'],
        };
        await api.updateNotificationService(value.id, input);
      } else {
        const input = {
          name: value.name,
          enabled: value.enabled,
          provider: value.provider,
          config,
        } as NotificationServiceCreate;
        await api.createNotificationService(input);
      }
      onSaved();
    } catch (reason) {
      setError(messageFor(reason, 'The notification service could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="monitor-form notification-editor" onSubmit={submit}>
      <div className="notification-editor__heading">
        <div>
          <h2>{editing ? 'Edit service' : 'Add notification service'}</h2>
          <p>Credentials are stored for sending and are never returned to the browser.</p>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Name</span>
          <input
            value={value.name}
            maxLength={120}
            required
            onChange={(event) => set('name', event.target.value)}
          />
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            value={value.provider}
            disabled={editing}
            onChange={(event) => set('provider', event.target.value as NotificationProviderKind)}
          >
            {Object.entries(providerLabels).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
          {editing && <small>The provider cannot be changed after creation.</small>}
        </label>
      </div>

      <ProviderFields value={value} set={set} editing={editing} />

      <label className="notification-enabled">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => set('enabled', event.target.checked)}
        />
        Enable this service
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button button--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save service'}
        </button>
      </div>
    </form>
  );
}

function messageFor(reason: unknown, fallback: string) {
  return reason instanceof RequestError || reason instanceof Error ? reason.message : fallback;
}

export function buildNotificationConfig(value: EditorState) {
  const config: Record<string, unknown> = {};
  const put = (key: string, item: unknown, secret = false) => {
    if (!secret || (typeof item === 'string' && item.length > 0)) config[key] = item;
  };
  const putOptional = (key: string, item: string) => {
    if (item.trim() || value.id) config[key] = item.trim();
  };
  switch (value.provider) {
    case 'telegram':
      put('botToken', value.botToken, true);
      put('chatId', value.chatId);
      break;
    case 'discord':
      put('webhookUrl', value.webhookUrl, true);
      break;
    case 'resend':
      put('apiKey', value.apiKey, true);
      put('from', value.from);
      put('to', recipients(value.to));
      putOptional('subject', value.subject);
      break;
    case 'gotify':
      put('serverUrl', value.serverUrl);
      put('applicationToken', value.applicationToken, true);
      put('priority', Number(value.priority || 8));
      break;
    case 'webhook':
      put('webhookUrl', value.webhookUrl, true);
      put('bearerToken', value.bearerToken, true);
      break;
    case 'smtp':
      put('host', value.host);
      put('port', Number(value.port || 587));
      put('security', value.security);
      putOptional('username', value.username);
      put('password', value.password, true);
      put('from', value.from);
      put('to', recipients(value.to));
      putOptional('subject', value.subject);
      break;
    case 'home-assistant':
      put('serverUrl', value.serverUrl);
      put('accessToken', value.accessToken, true);
      put('service', value.service || 'notify');
      break;
    case 'bluesky':
      put('handle', value.handle?.trim() ?? '');
      put('appPassword', value.appPassword ?? '', true);
      break;
  }
  return config;
}

function ProviderFields({
  value,
  set,
  editing,
}: {
  value: EditorState;
  set: <K extends keyof EditorState>(key: K, next: EditorState[K]) => void;
  editing: boolean;
}) {
  const secret = (
    label: string,
    key: keyof EditorState,
    placeholder: string,
    options: { required?: boolean; savedValue?: string; savedPlaceholder?: string } = {},
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete="new-password"
        inputMode={value.provider === 'discord' ? 'url' : undefined}
        value={value[key] as string}
        required={(options.required ?? true) && !editing}
        placeholder={
          editing
            ? `Leave blank to keep the saved ${options.savedPlaceholder ?? options.savedValue ?? 'value'}`
            : placeholder
        }
        onChange={(event) => set(key, event.target.value)}
      />
      {editing && <small>Leave blank to keep the saved {options.savedValue ?? 'value'}.</small>}
    </label>
  );
  const text = (label: string, key: keyof EditorState, required = true, placeholder?: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        value={value[key] as string}
        required={required}
        placeholder={placeholder}
        onChange={(event) => set(key, event.target.value)}
      />
    </label>
  );
  const recipientsField = (label: string) => (
    <label className="field">
      <span>{label}</span>
      <textarea
        value={value.to}
        required
        onChange={(event) => set('to', event.target.value)}
        rows={3}
      />
    </label>
  );
  const instructions: Partial<Record<NotificationProviderKind, string>> = {
    telegram:
      'Create a bot with BotFather and copy its token. Start the bot or add it to a group, send a message, then use Telegram’s getUpdates endpoint to find the chat ID.',
    discord:
      'Open Server Settings, Integrations, Webhooks. Create or select a webhook and copy its webhook URL.',
    resend: 'Create an API key with permission to send mail and verify the From domain.',
    bluesky:
      'Enter the handle for a Bluesky-hosted account or an account on a custom PDS; its PDS is discovered automatically from the handle. Create an app password in Settings → Privacy and Security → App Passwords. Alerts and Test both publish publicly to your profile.',
  };
  const mailFields = (
    <>
      {text('From email', 'from')}
      {recipientsField('To email addresses')}
      {text('Subject', 'subject', false)}
    </>
  );
  const fields: Record<NotificationProviderKind, React.ReactNode> = {
    telegram: (
      <>
        {secret('Bot token', 'botToken', '123456:ABC…', { savedValue: 'token' })}
        {text('Chat ID', 'chatId', true, '-1001234567890')}
      </>
    ),
    discord: secret('Webhook URL', 'webhookUrl', 'https://discord.com/api/webhooks/…', {
      savedValue: 'webhook URL',
      savedPlaceholder: 'URL',
    }),
    resend: (
      <>
        {secret('API key', 'apiKey', 're_…')}
        {mailFields}
      </>
    ),
    gotify: (
      <>
        {text('Server URL', 'serverUrl')}
        {secret('Application token', 'applicationToken', 'Application token')}
        {text('Priority (0–10)', 'priority')}
      </>
    ),
    webhook: (
      <>
        {secret('Webhook URL', 'webhookUrl', 'https://example.com/hook')}
        {secret('Bearer token', 'bearerToken', 'Optional bearer token', { required: false })}
      </>
    ),
    'home-assistant': (
      <>
        {text('Server URL', 'serverUrl')}
        {secret('Access token', 'accessToken', 'Long-lived access token')}
        {text('Service', 'service')}
      </>
    ),
    bluesky: (
      <>
        {text('Bluesky handle', 'handle', true, 'you.bsky.social')}
        {secret('App password', 'appPassword', 'xxxx-xxxx-xxxx-xxxx', {
          savedValue: 'app password',
        })}
      </>
    ),
    smtp: (
      <>
        {text('SMTP host', 'host')}
        {text('Port', 'port')}
        <label className="field">
          <span>Security</span>
          <select
            value={value.security}
            onChange={(event) => set('security', event.target.value as EditorState['security'])}
          >
            <option value="starttls">STARTTLS</option>
            <option value="tls">TLS</option>
            <option value="none">None</option>
          </select>
        </label>
        {text('Username', 'username', false)}
        {secret('Password', 'password', 'Optional password', { required: false })}
        {mailFields}
      </>
    ),
  };
  return (
    <>
      {instructions[value.provider] && (
        <aside className="notification-instructions">
          <strong>{providerLabels[value.provider]} setup</strong>
          <p>{instructions[value.provider]}</p>
        </aside>
      )}
      {value.provider === 'discord' ? (
        fields.discord
      ) : (
        <div className="form-grid">{fields[value.provider]}</div>
      )}
      {value.provider === 'smtp' && (
        <small>Recipients accept comma or newline separated email addresses.</small>
      )}
      {value.provider === 'smtp' && value.security === 'none' && (
        <p className="field-error">
          SMTP security is disabled. Credentials and notification content will be sent in plaintext.
        </p>
      )}
    </>
  );
}
