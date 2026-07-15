import type Redis from 'ioredis';
import type { NotificationChannel } from './types.js';

/**
 * Preferences cache in Redis so the fanout hot path can apply the
 * preference filter (the cheapest reducer) without a MySQL hit. Only active
 * users need an entry — everyone else is never fanned a notification.
 */
export const prefsKey = (userId: string) => `prefs:${userId}`;

export interface CachedPrefs {
  inApp: boolean;
  email: boolean;
  push: boolean;
  muted: string[];
}

const DEFAULT: CachedPrefs = { inApp: true, email: false, push: false, muted: [] };

export async function savePrefs(
  redis: Redis,
  userId: string,
  p: { inApp: boolean; email: boolean; push: boolean; mutedClubs: string[] },
): Promise<void> {
  await redis.hset(prefsKey(userId), {
    in_app: p.inApp ? '1' : '0',
    email: p.email ? '1' : '0',
    push: p.push ? '1' : '0',
    muted: p.mutedClubs.join(','),
  });
}

export function parsePrefs(h: Record<string, string>): CachedPrefs {
  if (!h || Object.keys(h).length === 0) return DEFAULT;
  return {
    inApp: h.in_app !== '0',
    email: h.email === '1',
    push: h.push === '1',
    muted: h.muted ? h.muted.split(',').filter(Boolean) : [],
  };
}

/** Which channels should fire for this user+club, after the preference filter. */
export function channelsFor(p: CachedPrefs, clubId: string): NotificationChannel[] {
  if (p.muted.includes(clubId)) return [];
  const out: NotificationChannel[] = [];
  if (p.inApp) out.push('in_app');
  if (p.email) out.push('email');
  if (p.push) out.push('push');
  return out;
}
