// Verifies the token Cloudflare Access puts on every request it lets through (header Cf-Access-Jwt-Assertion,
// cookie CF_Authorization), so a page behind Access stays closed when reached around it, e.g. on the LAN port.
import { createPublicKey, verify } from 'node:crypto';

type Jwk = Record<string, unknown> & { kid?: string };

/** Returns the signed-in person's email, or null for anything else: bad signature, other app, expired, a service token. */
export function accessVerifier(o: { teamDomain: string; aud: string; fetch?: typeof fetch; now?: () => number }):
  (token: string) => Promise<string | null> {
  const get = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const issuer = `https://${o.teamDomain}`;
  let keys: Jwk[] = [];
  let fetchedAt = 0;
  const load = async () => {
    const res = await get(`${issuer}/cdn-cgi/access/certs`);
    keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
    fetchedAt = now();
  };
  const key = async (kid: string) => {
    if (!keys.length || now() - fetchedAt > 3_600_000) await load();
    let k = keys.find(x => x.kid === kid);
    if (!k) { await load(); k = keys.find(x => x.kid === kid); } // Access rotates its keys
    return k;
  };
  return async token => {
    try {
      const [h, p, s] = token.split('.');
      if (!h || !p || !s) return null;
      const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string; kid?: string };
      if (header.alg !== 'RS256' || !header.kid) return null;
      const jwk = await key(header.kid);
      if (!jwk) return null;
      const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(s, 'base64url'));
      if (!ok) return null;
      const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as
        { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
      const t = now() / 1000;
      const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
      if (!aud.includes(o.aud) || c.iss !== issuer || !c.exp || c.exp < t || (c.nbf && c.nbf > t)) return null;
      return typeof c.email === 'string' && c.email ? c.email : null;
    } catch {
      return null;
    }
  };
}
