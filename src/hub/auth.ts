import crypto from 'node:crypto';
import type http from 'node:http';

export const SESSION_COOKIE = 'ca_session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

export type RequestLike = { headers: http.IncomingHttpHeaders; url?: string };

export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function dashboardCookieValue(token: string): string {
  return crypto.createHmac('sha256', token).update('claude-alarm-dashboard').digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch {}
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${dashboardCookieValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
}

export function isAuthorized(req: RequestLike, token: string, allowQueryToken: boolean): boolean {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return true;
  if (safeEqual(parseCookies(req.headers.cookie)[SESSION_COOKIE], dashboardCookieValue(token))) return true;
  if (allowQueryToken) {
    const q = new URL(req.url ?? '/', 'http://hub').searchParams.get('token');
    if (safeEqual(q, token)) return true;
  }
  return false;
}

export function isCrossOrigin(req: RequestLike): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

export function isJsonRequest(req: RequestLike): boolean {
  return String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}

export function isSecureRequest(req: RequestLike): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}
