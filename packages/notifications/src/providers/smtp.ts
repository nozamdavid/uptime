import { Socket } from 'node:net';
import nodemailer, { type SendMailOptions, type SMTPTransportOptions } from 'nodemailer';
import { smtpConfigSchema, type NotificationMessage } from '@uptime/contracts';
import { NotificationProvider } from '../notification-provider.js';
import { NotificationDeliveryError } from '../delivery.js';
import { messageText } from '../message.js';

interface MailTransport {
  sendMail(message: SendMailOptions): Promise<{ rejected?: unknown[] }>;
  close(): void;
}

type TransportFactory = (options: SMTPTransportOptions) => MailTransport;

export class SmtpNotificationProvider extends NotificationProvider {
  private readonly config;

  constructor(
    config: unknown,
    _fetchImpl: typeof fetch = fetch,
    private readonly transportFactory: TransportFactory = (options) =>
      nodemailer.createTransport(options),
  ) {
    super();
    this.config = smtpConfigSchema.parse(config);
  }

  async send(message: NotificationMessage): Promise<void> {
    // Own the socket so the overall deadline also stops an SMTP server that keeps responding slowly.
    const socket = new Socket();
    let transport: MailTransport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      transport = this.transportFactory({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.security === 'tls',
        requireTLS: this.config.security === 'starttls',
        ignoreTLS: this.config.security === 'none',
        tls: { rejectUnauthorized: true },
        getSocket: (_options, callback) => {
          if (socket.destroyed) {
            callback(new NotificationDeliveryError(true));
            return;
          }
          const onError = (error: Error) => callback(error);
          socket.once('error', onError);
          socket.connect(this.config.port, this.config.host, () => {
            socket.removeListener('error', onError);
            callback(null, { connection: socket });
          });
        },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
        dnsTimeout: 10_000,
        disableFileAccess: true,
        disableUrlAccess: true,
        ...(this.config.username
          ? {
              auth: { user: this.config.username, pass: this.config.password ?? '' },
            }
          : {}),
      });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          socket.destroy();
          reject(new NotificationDeliveryError(true));
        }, 10_000);
      });
      const result = await Promise.race([
        transport.sendMail({
          from: this.config.from,
          to: this.config.to,
          subject: this.config.subject || 'Uptime notification',
          text: messageText(message),
        }),
        deadline,
      ]);
      // Retrying a partial delivery would send duplicates to the recipients who already accepted it.
      if (result.rejected?.length) throw new NotificationDeliveryError(false);
    } catch (error) {
      if (error instanceof NotificationDeliveryError) throw error;
      const code =
        error && typeof error === 'object' && 'responseCode' in error
          ? error.responseCode
          : undefined;
      const name = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const permanent =
        typeof code === 'number'
          ? code >= 500
          : name === 'EAUTH' || name === 'ETLS' || name === 'EENVELOPE';
      throw new NotificationDeliveryError(!permanent);
    } finally {
      if (timer) clearTimeout(timer);
      socket.destroy();
      transport?.close();
    }
  }
}
