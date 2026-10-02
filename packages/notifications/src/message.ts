import type { NotificationMessage } from '@uptime/contracts';

export function messageText(message: NotificationMessage): string {
  if (message.kind === 'test')
    return 'Uptime notification test\nYour notification service is connected.';
  const title = { outage: 'OUTAGE', recovery: 'RECOVERED', reminder: 'STILL DOWN' }[message.kind];
  const lines = [
    title,
    message.monitorName.slice(0, 120),
    message.monitorUrl.slice(0, 1200),
    `Time: ${message.occurredAt}`,
  ];
  if (message.outageStartedAt) lines.push(`Outage started: ${message.outageStartedAt}`);
  return lines.join('\n');
}
