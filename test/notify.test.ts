import { expect, test, vi } from 'vitest';
import { createNotifier } from '../src/notify.ts';

const ok = () => vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }));

test('telegram body contains title and body', async () => {
  const f = ok();
  await createNotifier({ telegram: { token: 'T', chatId: '42' }, haPersistent: false }, f, {}).alert('Sync failing', 'server down');
  const [url, init] = f.mock.calls[0];
  expect(url).toBe('https://api.telegram.org/botT/sendMessage');
  const body = JSON.parse(init.body as string);
  expect(body.chat_id).toBe('42');
  expect(body.text).toContain('Sync failing');
  expect(body.text).toContain('server down');
});

test('HA persistent notification needs SUPERVISOR_TOKEN', async () => {
  const f = ok();
  await createNotifier({ haPersistent: true }, f, {}).alert('t', 'b');
  expect(f).not.toHaveBeenCalled();
  await createNotifier({ haPersistent: true }, f, { SUPERVISOR_TOKEN: 'S' }).alert('t', 'b');
  const [url, init] = f.mock.calls[0];
  expect(url).toBe('http://supervisor/core/api/services/persistent_notification/create');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer S');
  expect(JSON.parse(init.body as string)).toMatchObject({ title: 't', message: 'b' });
});

test('a failing channel never throws', async () => {
  const f = vi.fn(async () => { throw new Error('offline'); });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(createNotifier({ telegram: { token: 'T', chatId: '1' }, haPersistent: false }, f, {}).alert('t', 'b')).resolves.toBeUndefined();
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});
