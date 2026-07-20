import type {
  Club,
  EventType,
  FeedPage,
  Me,
  Metrics,
  Preferences,
} from './types';

// All requests are same-origin relative paths. In dev, Vite proxies /api to
// the backend; in production the LB serves the app and API on one origin.
const BASE = '/api';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getHealth(): Promise<{ ok: boolean }> {
  return getJson('/health');
}

export function getMe(): Promise<Me> {
  return getJson('/me');
}

export function getClubs(): Promise<Club[]> {
  return getJson('/clubs');
}

export interface FeedQuery {
  userId: string;
  limit?: number;
  before?: string;
  after?: string;
}

export function getFeed(q: FeedQuery): Promise<FeedPage> {
  const params = new URLSearchParams();
  params.set('userId', q.userId);
  params.set('limit', String(q.limit ?? 20));
  if (q.before) params.set('before', q.before);
  if (q.after) params.set('after', q.after);
  return getJson(`/feed?${params.toString()}`);
}

export async function postEvent(body: {
  clubId: string;
  type: EventType;
  text?: string;
}): Promise<{ accepted: boolean; eventId: string }> {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST /events failed: ${res.status}`);
  }
  return res.json();
}

export function getPreferences(userId: string): Promise<Preferences> {
  return getJson(`/preferences?userId=${encodeURIComponent(userId)}`);
}

export async function putPreferences(prefs: Preferences): Promise<Preferences> {
  const res = await fetch(`${BASE}/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  });
  if (!res.ok) {
    throw new Error(`PUT /preferences failed: ${res.status}`);
  }
  return res.json();
}

// Metrics polls every 1s; give each one a hard timeout so a slow/overloaded API
// during a load spike rejects promptly instead of hanging and stacking requests.
export async function getMetrics(): Promise<Metrics> {
  const res = await fetch(`${BASE}/metrics`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`GET /metrics failed: ${res.status}`);
  return res.json() as Promise<Metrics>;
}
