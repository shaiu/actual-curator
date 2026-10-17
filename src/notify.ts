// Operator alerts. Best effort: a failing channel is logged, never thrown, so an alert about a
// failure can not become a second failure.
import type { FetchLike } from './classifier/types.ts';
import type { Config } from './config.ts';

export type Notifier = { alert(title: string, body: string): Promise<void> };

export function createNotifier(cfg: Config['notify'], fetchImpl: FetchLike = fetch,
                               env: Record<string, string | undefined> = process.env): Notifier {
  const send = async (channel: string, url: string, init: RequestInit) => {
    try {
      const res = await fetchImpl(url, init);
      if (!res.ok) console.error(`alert via ${channel} failed: HTTP ${res.status}`);
    } catch (e) {
      console.error(`alert via ${channel} failed: ${(e as Error).message}`);
    }
  };
  return {
    async alert(title, body) {
      console.warn(`ALERT ${title}: ${body}`);
      const jobs: Promise<void>[] = [];
      if (cfg.telegram) {
        jobs.push(send('telegram', `https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `${title}\n${body}` }),
        }));
      }
      if (cfg.haPersistent && env.SUPERVISOR_TOKEN) {
        jobs.push(send('home assistant', 'http://supervisor/core/api/services/persistent_notification/create', {
          method: 'POST', headers: { authorization: `Bearer ${env.SUPERVISOR_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ title, message: body, notification_id: 'actual_curator' }),
        }));
      }
      await Promise.all(jobs);
    },
  };
}
