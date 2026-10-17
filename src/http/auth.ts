import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export function bearer(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (c, next) => {
    const got = Buffer.from(c.req.header('authorization') ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return c.json({ error: { code: 'unauthorized', message: 'Missing or wrong bearer token' } }, 401);
    }
    await next();
  };
}
