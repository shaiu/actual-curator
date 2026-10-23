import { createSign, generateKeyPairSync } from 'node:crypto';
import { expect, test } from 'vitest';
import { accessVerifier } from '../../src/http/access.ts';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const NOW = 1_800_000_000;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) {
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`;
}
const good = { aud: [AUD], iss: `https://${TEAM}`, exp: NOW + 60, iat: NOW - 60, email: 'me@example.com' };

function verifier(keys: unknown[] = [jwk]) {
  const urls: string[] = [];
  const v = accessVerifier({ teamDomain: TEAM, aud: AUD, now: () => NOW * 1000,
    fetch: (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ keys })); }) as typeof fetch });
  return { v, urls };
}

test('a token signed by the team key for this app returns the email', async () => {
  const { v, urls } = verifier();
  expect(await v(sign(good))).toBe('me@example.com');
  expect(urls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  await v(sign(good));
  expect(urls).toHaveLength(1); // keys are cached
});

test('wrong audience, wrong issuer, expired, not yet valid and tampered tokens are refused', async () => {
  const { v } = verifier();
  expect(await v(sign({ ...good, aud: ['other'] }))).toBeNull();
  expect(await v(sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }))).toBeNull();
  expect(await v(sign({ ...good, exp: NOW - 1 }))).toBeNull();
  expect(await v(sign({ ...good, nbf: NOW + 60 }))).toBeNull();
  const [h, , s] = sign(good).split('.');
  expect(await v(`${h}.${b64({ ...good, email: 'other@example.com' })}.${s}`)).toBeNull();
  expect(await v(sign(good, { alg: 'none', kid: 'k1' }))).toBeNull();
  expect(await v('garbage')).toBeNull();
});

test('a service token (no email) is not a person and is refused', async () => {
  const { v } = verifier();
  const { email: _e, ...service } = good;
  expect(await v(sign({ ...service, common_name: 'svc.access' }))).toBeNull();
});

test('an unknown key id refetches the keys once (rotation), then refuses', async () => {
  const { v, urls } = verifier();
  expect(await v(sign(good, { alg: 'RS256', kid: 'k2' }))).toBeNull();
  expect(urls).toHaveLength(2);
});
